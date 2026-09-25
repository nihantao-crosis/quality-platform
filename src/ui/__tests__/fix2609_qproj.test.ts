/**
 * fix2609 G2-qproj：.qproj 跨版本兼容回归（GAP-4-11 / GAP-4-12 / PLATFORM-03 / PLATFORM-04 / PLATFORM-01）。
 *
 * fixtures/qproj/*.qproj 是用历史 tag 的**真实写出侧**生成的项目文件：
 * 把 `git archive <tag>` 解出的源码树接上当前 node_modules，在 jsdom 里驱动该版本自己的
 * useData/useApp/useAnalyses 真实 store 操作，再调用该版本自己的 buildProjectJson /
 * buildProjectJsonFull 导出，原样落盘（未做任何手工改写）：
 * - v1.29.0-fv1：导入宽表 → 改一格 → 撤销（v1.29 restoreSnapshot 只写活动表）→
 *   保存单因子 ANOVA 与图形化摘要卡片（v1.29 卡片无 snapshotVersion/sourceData）→ Web 导出。
 * - v1.34.0-fv2-web / v1.41.0-fv3-web：导入两表，保存 ANOVA/摘要/SPC/能力卡片 → Web 导出。
 * - v1.38.0-fv2-desktop / v1.42.4-fv4-desktop：挂内存 DatasetDb（库中预置仅在库里的
 *   「批次C.mtw」），同样操作后桌面完整导出；最近列表带全量数据的批次A/B 被按设计从 vault 去重省略。
 *   v1.42.4 另在分析数据仓库留一条没有卡片引用的残留（v1.42.4 的导出侧不检查孤儿，原样写出）。
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { platform, type DatasetDb, type DatasetImportEntry } from '../../platform/adapter';
import {
  PREFS_STATE_KEYS,
  PROJECT_FORMAT_VERSION,
  applyProjectJson,
  applyProjectText,
  buildProjectJson,
  buildProjectJsonFull,
  projectStoreValidationError,
} from '../../platform/project';
import { useAnalyses, type SavedAnalysis } from '../../store/analyses';
import { useApp } from '../../store/appStore';

const FIXTURE_DIR = 'src/ui/__tests__/fixtures/qproj';
const fixture = (name: string) => readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8');
const parseFile = (text: string) => JSON.parse(text.replace(/^\uFEFF/, '')) as {
  formatVersion: number;
  stores: Record<string, string>;
  vault?: Record<string, string>;
};

function worksheet(name: string, first: number, savedAt = '2026-08-13T00:00:00Z') {
  return { name, colNames: ['x'], rows: [[first], [first + 1], [first + 2]], textCols: [], savedAt };
}

function projectText(
  formatVersion: number,
  stores: Record<string, string>,
  vault?: Record<string, string>,
) {
  return JSON.stringify({
    format: 'quality-platform-project', formatVersion, appVersion: 'test', exportedAt: 't',
    stores, ...(vault ? { vault } : {}),
  });
}

function card(id: string, kind: string, snapshot: Record<string, unknown>, datasetName = '批次A.mtw') {
  return {
    id, kind, title: `卡片${id}`, datasetName, metric: 'm', status: '已完成',
    statusColor: '#2c8a45', statusBg: '#e8f4ea', createdAt: Date.UTC(2026, 6, 10, 8, 0, 0), snapshot,
  };
}

function baseDb(store: Map<string, string>): DatasetDb {
  return {
    async put(name, json) { store.set(name, json); },
    async insert(name, json) { if (store.has(name)) return false; store.set(name, json); return true; },
    async get(name) { return store.get(name) ?? null; },
    async list() {
      return [...store.entries()].map(([name, json]) => ({ name, saved_at: 't', bytes: json.length }));
    },
    async remove(name) { return store.delete(name); },
    async clear(opId) { const removed = store.size; store.clear(); return { opId, committed: true, removed }; },
    async clearStatus() { return null; },
    async stats() { return { count: store.size, total_bytes: 0, path: ':memory:' }; },
  };
}

/** 与 src-tauri/src/db.rs begin_project_import 同语义：备份 → 清空 datasets → 只插入 entries。 */
function atomicDb(initial: Array<[string, string]> = []) {
  const store = new Map(initial);
  let backup: Map<string, string> | null = null;
  let journal: string | null = null;
  const db: DatasetDb = {
    ...baseDb(store),
    async beginProjectImport(entries: DatasetImportEntry[], pendingStoresJson: string) {
      if (journal != null) throw new Error('pending');
      backup = new Map(store);
      journal = pendingStoresJson;
      store.clear();
      for (const entry of entries) store.set(entry.name, entry.json);
    },
    async commitProjectImport() { backup = null; journal = null; },
    async rollbackProjectImport() {
      if (backup) { store.clear(); for (const [name, json] of backup) store.set(name, json); }
      backup = null;
      journal = null;
    },
    async pendingProjectImport() { return journal; },
  };
  return { db, store };
}

const storedJson = (key: string) => JSON.parse(localStorage.getItem(key) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  platform.datasetDb = null;
});

afterEach(() => {
  platform.datasetDb = null;
});

describe('历史写出侧夹具 formatVersion 1..4 均可在当前版本导入', () => {
  it('v1.29.0（fv1）：撤销后活动表与最近条目不一致不再整份拒绝，最近条目按活动表迁移（GAP-4-11）', async () => {
    const text = fixture('v1.29.0-fv1.qproj');
    const file = parseFile(text);
    expect(file.formatVersion).toBe(1);
    const active = JSON.parse(file.stores['qp-dataset-v1']);
    const staleRecent = JSON.parse(file.stores['qp-recents-v1'])[0];
    // 夹具确为真实缺陷形态：v1.29 撤销只写活动表，最近条目仍是撤销前矩阵。
    expect(active.rows[0][0]).toBe(10.1);
    expect(staleRecent.data.rows[0][0]).toBe(99);

    const result = await applyProjectText(text);
    expect(result.error).toBeNull();
    expect(result.note).toContain('旧版项目（格式 v1）');
    expect(result.note).toContain('批次A.mtw');
    const recents = storedJson('qp-recents-v1');
    expect(recents[0].data).toEqual(active);
    expect(recents[0].savedAt).toBe(active.savedAt);
    expect(localStorage.getItem('qp-dataset-v1')).toBe(file.stores['qp-dataset-v1']);
    // 旧版无来源的 ANOVA/摘要卡片随项目保留（PLATFORM-04），规格与偏好原样恢复。
    const analyses = storedJson('qp-analyses-v1') as SavedAnalysis[];
    expect(analyses.map((entry) => entry.kind).sort()).toEqual(['anova', 'summary']);
    expect(analyses.every((entry) => entry.snapshot.snapshotVersion === undefined)).toBe(true);
    expect(localStorage.getItem('qp-specs-v1')).toBe(file.stores['qp-specs-v1']);
    expect(localStorage.getItem('qp-prefs-v1')).toBe(file.stores['qp-prefs-v1']);
  });

  it.each([
    ['v1.34.0-fv2-web.qproj', 2],
    ['v1.41.0-fv3-web.qproj', 3],
  ])('%s：Web 导出的历史项目逐键原样导入', async (name, formatVersion) => {
    const text = fixture(name);
    const file = parseFile(text);
    expect(file.formatVersion).toBe(formatVersion);
    const result = await applyProjectText(text);
    expect(result.error).toBeNull();
    for (const [key, value] of Object.entries(file.stores)) {
      expect(localStorage.getItem(key)).toBe(value);
    }
  });

  it('v1.38.0（fv2 桌面）：最近列表带全量数据而被 vault 去重的数据集，导入后仍在本机库（PLATFORM-01）', async () => {
    const text = fixture('v1.38.0-fv2-desktop.qproj');
    const file = parseFile(text);
    expect(file.formatVersion).toBe(2);
    expect(Object.keys(file.vault ?? {})).toEqual(['批次C.mtw']);
    const fake = atomicDb([['无关旧集', JSON.stringify(worksheet('无关旧集', 1))]]);
    platform.datasetDb = fake.db;

    const result = await applyProjectText(text);
    expect(result.error).toBeNull();
    expect([...fake.store.keys()].sort()).toEqual(['批次A.mtw', '批次B.mtw', '批次C.mtw']);
    const recents = JSON.parse(file.stores['qp-recents-v1']) as Array<{ name: string; data: unknown }>;
    for (const recent of recents) {
      expect(JSON.parse(fake.store.get(recent.name)!)).toEqual(recent.data);
    }
    expect(result.note).toContain('恢复 3 个数据集');
    expect(result.note).toContain('其中 2 个来自最近列表');
  });

  it('v1.42.4（fv4 桌面）：残留孤儿分析数据被丢弃而非整份拒绝，库同样完整（GAP-4-12 + PLATFORM-01）', async () => {
    const text = fixture('v1.42.4-fv4-desktop.qproj');
    const file = parseFile(text);
    expect(file.formatVersion).toBe(4);
    const originalData = JSON.parse(file.stores['qp-analysis-data-v1']) as Record<string, unknown>;
    expect(Object.keys(originalData)).toContain('k-orphan-residue');
    const fake = atomicDb();
    platform.datasetDb = fake.db;

    const result = await applyProjectText(text);
    expect(result.error).toBeNull();
    expect(result.note).toContain('旧版项目（格式 v4）含 1 条没有分析卡片引用的残留分析数据');
    const importedData = storedJson('qp-analysis-data-v1') as Record<string, unknown>;
    expect(Object.keys(importedData)).not.toContain('k-orphan-residue');
    const analyses = storedJson('qp-analyses-v1') as SavedAnalysis[];
    const referenced = new Set(analyses.map((entry) => entry.snapshot.sourceDataKey).filter(Boolean));
    expect(new Set(Object.keys(importedData))).toEqual(referenced);
    expect(localStorage.getItem('qp-analyses-v1')).toBe(file.stores['qp-analyses-v1']);
    expect([...fake.store.keys()].sort()).toEqual(['批次A.mtw', '批次B.mtw', '批次C.mtw']);
  });
});

describe('GAP-4-11：跨键一致性按 formatVersion 门控，保留对 v5 的严格校验', () => {
  it('仅 savedAt 不同、矩阵逐位相同不是回退，v5 也照常导入', () => {
    const active = worksheet('A', 1, '2026-08-13T02:00:00Z');
    const recent = worksheet('A', 1, '2026-08-13T01:00:00Z');
    expect(applyProjectJson(projectText(5, {
      'qp-dataset-v1': JSON.stringify(active),
      'qp-recents-v1': JSON.stringify([{ name: 'A', savedAt: recent.savedAt, data: recent }]),
    }))).toBeNull();
  });

  it('v5 文件矩阵不一致仍在任何写入前整份拒绝（守卫未拆）', () => {
    const marker = JSON.stringify({ keep: { lsl: 0, tgt: 1, usl: 2 } });
    localStorage.setItem('qp-specs-v1', marker);
    const active = worksheet('A', 100);
    const stale = worksheet('A', 1);
    expect(applyProjectJson(projectText(5, {
      'qp-dataset-v1': JSON.stringify(active),
      'qp-recents-v1': JSON.stringify([{ name: 'A', savedAt: stale.savedAt, data: stale }]),
    }))).toContain('回退旧矩阵');
    expect(localStorage.getItem('qp-specs-v1')).toBe(marker);
  });

  it.each([1, 2, 3, 4])('formatVersion=%i 的不一致文件以活动表为准迁移最近条目', (formatVersion) => {
    const active = worksheet('A', 100, '2026-08-13T02:00:00Z');
    const stale = worksheet('A', 1, '2026-08-13T01:00:00Z');
    const other = worksheet('B', 7);
    expect(applyProjectJson(projectText(formatVersion, {
      'qp-dataset-v1': JSON.stringify(active),
      'qp-recents-v1': JSON.stringify([
        { name: 'A', savedAt: stale.savedAt, data: stale },
        { name: 'B', savedAt: other.savedAt, data: other },
      ]),
    }))).toBeNull();
    const recents = storedJson('qp-recents-v1');
    expect(recents[0]).toEqual({ name: 'A', savedAt: active.savedAt, data: active });
    expect(recents[1].data).toEqual(other);
    expect(projectStoreValidationError('qp-recents-v1', recents)).toBeNull();
  });

  it('旧版桌面文件的 SQLite 活动表与陈旧最近条目同样按 vault 活动表迁移', async () => {
    const current = worksheet('X', 50, '2026-08-13T02:00:00Z');
    const stale = worksheet('X', 5, '2026-08-13T01:00:00Z');
    const fake = atomicDb();
    platform.datasetDb = fake.db;
    const result = await applyProjectText(projectText(2, {
      'qp-active-ref-v1': 'X',
      'qp-recents-v1': JSON.stringify([{ name: 'X', savedAt: stale.savedAt, data: stale }]),
    }, { X: JSON.stringify(current) }));
    expect(result.error).toBeNull();
    expect(storedJson('qp-recents-v1')[0].data).toEqual(current);
    expect(JSON.parse(fake.store.get('X')!)).toEqual(current);
  });
});

describe('GAP-4-12：孤儿分析数据是残留，导出前丢弃、旧文件导入时丢弃', () => {
  const source = (name: string) => ({ ...worksheet(name, 3), savedAt: undefined });

  it('本机出现孤儿时导出不再被自校验阻断，导出件只含被引用的数据并可原样再导入', () => {
    localStorage.setItem('qp-analyses-v1', JSON.stringify([card('a1', 'summary', { snapshotVersion: 7, sourceDataKey: 'k-live' }, '批次A.mtw')]));
    localStorage.setItem('qp-analysis-data-v1', JSON.stringify({ 'k-live': source('批次A.mtw'), 'k-orphan': source('批次A.mtw') }));
    const text = buildProjectJson('1.43.0');
    const file = parseFile(text);
    expect(file.formatVersion).toBe(5);
    expect(Object.keys(JSON.parse(file.stores['qp-analysis-data-v1']))).toEqual(['k-live']);
    localStorage.clear();
    expect(applyProjectJson(text)).toBeNull();
    expect(Object.keys(storedJson('qp-analysis-data-v1'))).toEqual(['k-live']);
  });

  it('全部分析卡已删除而仓库残留时整键省略', () => {
    localStorage.setItem('qp-specs-v1', '{}');
    localStorage.setItem('qp-analysis-data-v1', JSON.stringify({ 'k-orphan': source('批次A.mtw') }));
    const file = parseFile(buildProjectJson('1.43.0'));
    expect(file.stores['qp-analysis-data-v1']).toBeUndefined();
  });

  it('formatVersion ≤4 丢弃孤儿并导入；v5 带孤儿仍拒绝', () => {
    const stores = {
      'qp-analyses-v1': JSON.stringify([card('a1', 'summary', { snapshotVersion: 7, sourceDataKey: 'k-live' })]),
      'qp-analysis-data-v1': JSON.stringify({ 'k-live': source('批次A.mtw'), 'k-orphan': source('批次A.mtw') }),
    };
    for (const formatVersion of [1, 2, 3, 4]) {
      localStorage.clear();
      expect(applyProjectJson(projectText(formatVersion, stores))).toBeNull();
      expect(Object.keys(storedJson('qp-analysis-data-v1'))).toEqual(['k-live']);
    }
    localStorage.clear();
    expect(applyProjectJson(projectText(5, stores))).toContain('没有对应的分析历史引用');
    expect(localStorage.getItem('qp-analyses-v1')).toBeNull();
  });
});

describe('PLATFORM-03：新增偏好键同步提升 FORMAT_VERSION，旧读取器得到“请升级”而非“损坏”', () => {
  /** v1.42.4 的偏好白名单（git show v1.42.4:src/platform/project.ts 的 allowedStateKeys 原文）。 */
  const V4_PREFS_KEYS = [
    'chartStyle', 'showGrid', 'projectName', 'lsl', 'usl', 'tgt', 'lslOn', 'uslOn', 'capabilityBins',
    'capSubgroupMode', 'capSubgroupSize', 'capValueCol', 'capSubgroupIdCol',
    'gageUseReal', 'gageValueName', 'gagePartName', 'gageOperatorName',
    'gageGaugeName', 'gageReportBy', 'gageStudyDate', 'gageNotes',
    'gageTolMode', 'gageTolValue', 'gageStandard', 'gageBatchCols', 'gageTolByCol',
    'aqlLot', 'aqlLevel', 'aqlAQL', 'aqlRegime', 'aqlMethod', 'aqlAcMethod', 'aqlSwitch',
    'spcRules', 'spcRuleK', 'spcDataLayout', 'spcValueCol', 'spcSubgroupCol', 'spcStageCol',
    'spcSigmaMethod', 'spcShowZones',
    'doeView', 'doeTab', 'doeFactorCols', 'doeRespCol', 'doeModelTerms', 'doeIncludeCurvature',
    't1ColName', 't1Mu0', 't2ColAName', 't2ColBName', 'regXName', 'regYName',
    'paretoView', 'paretoMergeOther', 'paretoThreshold',
  ];
  /** 每个格式版本对应的偏好白名单；新增偏好键必须提升 FORMAT_VERSION 并在此登记。 */
  const PREFS_KEYS_BY_FORMAT_VERSION: Record<number, string[]> = {
    4: V4_PREFS_KEYS,
    5: [...V4_PREFS_KEYS, 'capabilityWarningAcknowledgement'],
  };

  /**
   * v1.42.4 读取器在偏好上的判定顺序（照录 v1.42.4 validateProjectFile → prefsValidationError）：
   * 先格式版本闸门（> 4 提示升级），再逐键白名单（白名单外即“损坏”）。
   */
  function v1424ReaderVerdict(text: string): string | null {
    const file = parseFile(text);
    if (file.formatVersion > 4) return `项目文件版本 ${file.formatVersion} 高于当前应用支持的 4,请升级应用`;
    const prefs = file.stores['qp-prefs-v1'];
    if (prefs === undefined) return null;
    const extra = Object.keys(JSON.parse(prefs).state).find((key) => !V4_PREFS_KEYS.includes(key));
    return extra ? `项目数据「qp-prefs-v1」损坏：偏好设置含有非白名单字段 ${extra}` : null;
  }

  it('当前导出总带 capabilityWarningAcknowledgement，格式版本高于 v1.42.4，旧版提示升级', async () => {
    useApp.setState({ capabilityWarningAcknowledgement: null });
    localStorage.setItem('qp-specs-v1', '{}');
    const text = await buildProjectJsonFull('1.43.0');
    const file = parseFile(text);
    const prefsState = JSON.parse(file.stores['qp-prefs-v1']).state as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(prefsState, 'capabilityWarningAcknowledgement')).toBe(true);
    expect(file.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(v1424ReaderVerdict(text)).toContain('请升级应用');
    expect(v1424ReaderVerdict(text)).not.toContain('损坏');
    // 写出侧的每个偏好键都在读取侧白名单内（写读对称）。
    for (const key of Object.keys(prefsState)) expect(PREFS_STATE_KEYS.has(key)).toBe(true);
    localStorage.clear();
    expect((await applyProjectText(text)).error).toBeNull();
  });

  it('偏好白名单与格式版本绑定：新增键未提升 FORMAT_VERSION 时本用例失败', () => {
    expect(PROJECT_FORMAT_VERSION).toBe(5);
    expect([...PREFS_STATE_KEYS].sort()).toEqual([...PREFS_KEYS_BY_FORMAT_VERSION[PROJECT_FORMAT_VERSION]].sort());
    const added = [...PREFS_STATE_KEYS].filter((key) => !V4_PREFS_KEYS.includes(key));
    if (added.length > 0) expect(PROJECT_FORMAT_VERSION).toBeGreaterThan(4);
  });
});

describe('PLATFORM-04：旧版无来源 ANOVA/DOE/摘要卡片不阻断导出/导入，回看 fail-closed', () => {
  const legacyCards = [
    card('legacy-anova', 'anova', { hypoTab: 'anova', anovaMode: 'wide', anovaRespName: null, anovaFactorName: null }),
    card('legacy-doe', 'doe', { doeView: 'main' }),
    card('legacy-summary', 'summary', {}),
  ];

  it('store 口径接受的旧卡片可随项目导出，导出件可再导入且卡片保留', () => {
    expect(projectStoreValidationError('qp-analyses-v1', legacyCards)).toBeNull();
    localStorage.setItem('qp-analyses-v1', JSON.stringify(legacyCards));
    const text = buildProjectJson('1.43.0');
    localStorage.clear();
    expect(applyProjectJson(text)).toBeNull();
    expect((storedJson('qp-analyses-v1') as SavedAnalysis[]).map((entry) => entry.id))
      .toEqual(legacyCards.map((entry) => entry.id));
  });

  it('旧卡片回看仍 fail-closed，当前数据不被改动', async () => {
    useAnalyses.setState({ saved: legacyCards as unknown as SavedAnalysis[], lastError: null });
    for (const entry of legacyCards) {
      await expect(useAnalyses.getState().restore(entry.id)).resolves.toBe(false);
    }
    expect(useApp.getState().toast).toContain('数据快照缺失');
  });

  it('带 snapshotVersion 却缺来源仍是损坏，错误文案给出卡片标题而非仅内部 id', () => {
    for (const snapshotVersion of [5, 7]) {
      const error = applyProjectJson(projectText(5, {
        'qp-analyses-v1': JSON.stringify([card('uuid-1', 'anova', { snapshotVersion, hypoTab: 'anova' })]),
      }));
      expect(error).toContain('没有 sourceData 或 sourceDataKey');
      expect(error).toContain('「卡片uuid-1」');
      expect(error).toContain('数据集 批次A.mtw');
    }
  });
});

describe('PLATFORM-01：当前版本桌面导出 → 导入后本机库不丢最近列表里的数据集', () => {
  function seedDesktopSource() {
    const a = worksheet('批次A', 1);
    const b = worksheet('批次B', 2);
    const source = new Map<string, string>([
      ['批次A', JSON.stringify(a)], ['批次B', JSON.stringify(b)], ['批次C', JSON.stringify(worksheet('批次C', 3))],
    ]);
    localStorage.setItem('qp-dataset-v1', JSON.stringify(b));
    localStorage.setItem('qp-recents-v1', JSON.stringify([
      { name: '批次B', savedAt: b.savedAt, data: b },
      { name: '批次A', savedAt: a.savedAt, data: a },
      { name: '批次C', savedAt: 't' },
    ]));
    platform.datasetDb = baseDb(source);
  }

  it('原子导入（SQLite 单事务）', async () => {
    seedDesktopSource();
    const text = await buildProjectJsonFull('1.43.0');
    // 导出侧去重不变：最近列表已带全量的不重复嵌入 vault。
    expect(Object.keys(parseFile(text).vault ?? {})).toEqual(['批次C']);
    localStorage.clear();
    const target = atomicDb([['别的机器旧集', JSON.stringify(worksheet('别的机器旧集', 9))]]);
    platform.datasetDb = target.db;
    const result = await applyProjectText(text);
    expect(result.error).toBeNull();
    expect([...target.store.keys()].sort()).toEqual(['批次A', '批次B', '批次C']);
    expect(result.note).toContain('恢复 3 个数据集');
  });

  it('非原子适配器（逐条 put + 删除快照外残留）', async () => {
    seedDesktopSource();
    const text = await buildProjectJsonFull('1.43.0');
    localStorage.clear();
    const target = new Map<string, string>([['别的机器旧集', JSON.stringify(worksheet('别的机器旧集', 9))]]);
    platform.datasetDb = baseDb(target);
    const result = await applyProjectText(text);
    expect(result.error).toBeNull();
    expect([...target.keys()].sort()).toEqual(['批次A', '批次B', '批次C']);
  });
});
