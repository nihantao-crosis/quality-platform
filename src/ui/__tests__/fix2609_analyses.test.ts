/**
 * 2026-09 全面审查 G3-analyses 回归：
 * - STORE-01 分析数据库上限 = 分析条数上限 = 40,第 41 次保存不得让库瞬时超限而被整库隔离删除；
 *   prune 读库失败时不得用空表 removeItem 覆盖 live 库；主索引写失败时去重库回滚。
 * - STORE-02 回看快照时，与快照同名的**非活动**最近数据集/本机库记录若内容不同，先安全另存副本。
 * - STORE-03 回看 P/C 图、帕累托、鱼骨图记录前，当前单槽数据若未被任何记录保存，先自动存为分析记录。
 * 全部走真实生产函数(useData/useAnalyses/fishboneStore/buildProjectJsonFull)。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnalyses } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, settlePendingDatasetWrites, useData } from '../../store/dataStore';
import { loadFishboneState, saveFishboneState, type FishboneData } from '../../store/fishboneStore';
import { buildProjectJsonFull } from '../../platform/project';
import { platform, type DatasetDb } from '../../platform/adapter';
import { MAX_SAVED_ANALYSES, MAX_ANALYSIS_DATA_ENTRIES } from '../../core';

const LS_ANALYSES = 'qp-analyses-v1';
const LS_ANALYSIS_DATA = 'qp-analysis-data-v1';
const LS_QUARANTINE = 'qp-quarantine-v1';
const LS_RECENTS = 'qp-recents-v1';

function memoryDb(store = new Map<string, string>()) {
  const db: DatasetDb = {
    put: vi.fn(async (name: string, json: string) => { store.set(name, json); }),
    insert: vi.fn(async (name: string, json: string) => {
      if (store.has(name)) return false;
      store.set(name, json);
      return true;
    }),
    get: vi.fn(async (name: string) => store.get(name) ?? null),
    list: vi.fn(async () => [...store.entries()].map(([name, json]) => ({ name, bytes: json.length, saved_at: 't' }))),
    remove: vi.fn(async (name: string) => store.delete(name)),
    async clear(opId) { const removed = store.size; store.clear(); return { opId, committed: true, removed }; },
    async clearStatus() { return null; },
    async stats() { return { count: store.size, total_bytes: 0, path: ':memory:' }; },
  };
  return { db, store };
}

function libraryEntries(): number | null {
  const raw = localStorage.getItem(LS_ANALYSIS_DATA);
  return raw == null ? null : Object.keys(JSON.parse(raw) as Record<string, unknown>).length;
}

function saveSummaryOf(name: string, rows: number[][]) {
  useData.getState().importMatrix(name, ['x'], rows);
  useApp.setState({ page: 'summary', activeVar: 'x' });
  const entry = useAnalyses.getState().saveCurrent();
  expect(entry).not.toBeNull();
  return entry!;
}

const fish = (problem: string, extraCause?: string): FishboneData => ({
  problem,
  categories: [
    { name: '人', causes: ['旧根因'] }, { name: '机', causes: extraCause ? [extraCause] : [] },
    { name: '料', causes: [] }, { name: '法', causes: [] }, { name: '环', causes: [] }, { name: '测', causes: [] },
  ],
});

beforeEach(() => {
  platform.datasetDb = null;
  localStorage.clear();
  cancelPendingDatasetWork();
  useAnalyses.setState({ saved: [], lastError: null });
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({
    page: 'dashboard', toast: null, spcType: 'xbar-r', activeVar: 'x',
    paretoView: 'pareto', paretoShowDemo: false, paretoMergeOther: false,
  });
});

afterEach(async () => {
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('STORE-01 分析数据库上限与 prune 顺序', () => {
  it('连续 41 次保存不同工作表：库任何时刻 ≤ 40 条、不被隔离，新旧记录均可回看，项目可导出', async () => {
    expect(MAX_ANALYSIS_DATA_ENTRIES).toBe(MAX_SAVED_ANALYSES);
    for (let i = 0; i < MAX_SAVED_ANALYSES; i++) {
      saveSummaryOf(`批次${i}.csv`, [[i + 1], [i + 2.5], [i + 3.25], [i + 4.75], [i + 6]]);
    }
    expect(libraryEntries()).toBe(MAX_SAVED_ANALYSES);
    let maxWritten = 0;
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === LS_ANALYSIS_DATA) maxWritten = Math.max(maxWritten, Object.keys(JSON.parse(value) as object).length);
      return originalSetItem.call(this, key, value);
    });
    const last = saveSummaryOf('批次41.csv', [[100], [101.5], [99.25], [102.75], [98]]);
    vi.restoreAllMocks();

    expect(maxWritten).toBeLessThanOrEqual(MAX_ANALYSIS_DATA_ENTRIES);
    expect(useAnalyses.getState().lastError).toBeNull();
    expect(useAnalyses.getState().saved).toHaveLength(MAX_SAVED_ANALYSES);
    expect(libraryEntries()).toBe(MAX_SAVED_ANALYSES);
    expect(localStorage.getItem(LS_QUARANTINE)).toBeNull();

    // 最新与最旧的保留记录都能回看
    expect(await useAnalyses.getState().restore(last.id)).toBe(true);
    expect(useData.getState().model.name).toBe('批次41.csv');
    const oldest = useAnalyses.getState().saved[MAX_SAVED_ANALYSES - 1];
    expect(await useAnalyses.getState().restore(oldest.id)).toBe(true);
    expect(useData.getState().model.name).toBe('批次1.csv');
    await expect(buildProjectJsonFull('test')).resolves.toContain(LS_ANALYSIS_DATA);
  });

  it('主索引写入失败时去重库回滚到保存前（被挤出的最旧记录快照仍在）', async () => {
    for (let i = 0; i < MAX_SAVED_ANALYSES; i++) {
      saveSummaryOf(`批次${i}.csv`, [[i + 1], [i + 2.5], [i + 3.25], [i + 4.75], [i + 6]]);
    }
    const before = localStorage.getItem(LS_ANALYSIS_DATA);
    const oldest = useAnalyses.getState().saved[MAX_SAVED_ANALYSES - 1];
    useData.getState().importMatrix('新批次.csv', ['x'], [[7], [8.5], [9.25], [10.75], [12]]);
    useApp.setState({ page: 'summary', activeVar: 'x' });
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === LS_ANALYSES) throw new DOMException('quota', 'QuotaExceededError');
      return originalSetItem.call(this, key, value);
    });
    expect(useAnalyses.getState().saveCurrent()).toBeNull();
    vi.restoreAllMocks();
    expect(useAnalyses.getState().lastError).toContain('本地存储空间不足');
    expect(localStorage.getItem(LS_ANALYSIS_DATA)).toBe(before);
    expect(localStorage.getItem(LS_QUARANTINE)).toBeNull();
    expect(await useAnalyses.getState().restore(oldest.id)).toBe(true);
    expect(useData.getState().model.name).toBe('批次0.csv');
  });

  it('prune 读库失败(隔离)时不得 removeItem 覆盖 live 库', () => {
    const entry = saveSummaryOf('A.csv', [[1], [2.5], [3.25], [4.75], [6]]);
    saveSummaryOf('B.csv', [[11], [12.5], [13.25], [14.75], [16]]);
    const corrupt = '{"truncated":';
    localStorage.setItem(LS_ANALYSIS_DATA, corrupt);
    expect(useAnalyses.getState().remove(entry.id)).toBe(true);
    expect(localStorage.getItem(LS_ANALYSIS_DATA)).toBe(corrupt);
    expect(JSON.parse(localStorage.getItem(LS_QUARANTINE)!)).toHaveProperty(LS_ANALYSIS_DATA);
  });
});

describe('STORE-02 非活动同名数据集回看前先安全另存', () => {
  it('Web:编辑 A 后切到 B,回看 A 的旧记录不静默覆盖最近列表中的 A 编辑', async () => {
    const entry = saveSummaryOf('A.csv', [[10], [11], [12], [13], [14]]);
    useData.getState().updateCell(0, 0, 777.25);
    useData.getState().importMatrix('B.csv', ['x'], [[0.5], [0.75], [1], [1.25], [1.5]]);
    expect(useData.getState().activeUnpersisted).toBe(false);

    expect(await useAnalyses.getState().restore(entry.id)).toBe(true);
    const state = useData.getState();
    expect(state.model.name).toBe('A.csv');
    expect(state.model.subs[0].vals[0]).toBe(10);
    const copy = state.recents.find((recent) => recent.name !== 'A.csv' && recent.name.includes('副本'));
    expect(copy?.data?.rows[0][0]).toBe(777.25);
    const persisted = JSON.parse(localStorage.getItem(LS_RECENTS)!) as { name: string; data?: { rows: number[][] } }[];
    expect(persisted.some((recent) => recent.data?.rows[0][0] === 777.25)).toBe(true);
    expect(useApp.getState().toast).toContain('已先安全另存为');
    expect(state.recents.some((recent) => recent.name === 'B.csv')).toBe(true);
  });

  it('内容与快照相同时不产生副本', async () => {
    const entry = saveSummaryOf('A.csv', [[10], [11], [12], [13], [14]]);
    useData.getState().importMatrix('B.csv', ['x'], [[0.5], [0.75], [1], [1.25], [1.5]]);
    expect(await useAnalyses.getState().restore(entry.id)).toBe(true);
    expect(useData.getState().recents.map((recent) => recent.name).sort()).toEqual(['A.csv', 'B.csv']);
  });

  it('桌面:非活动同名的本机库记录在回看后仍能从副本找回', async () => {
    vi.useFakeTimers();
    const fake = memoryDb();
    platform.datasetDb = fake.db;
    const entry = saveSummaryOf('A.csv', [[10], [11], [12], [13], [14]]);
    useData.getState().updateCell(0, 0, 777.25);
    useData.getState().importMatrix('B.csv', ['x'], [[0.5], [0.75], [1], [1.25], [1.5]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((JSON.parse(fake.store.get('A.csv')!) as { rows: number[][] }).rows[0][0]).toBe(777.25);

    const pending = useAnalyses.getState().restore(entry.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect((JSON.parse(fake.store.get('A.csv')!) as { rows: number[][] }).rows[0][0]).toBe(10);
    const survivors = [...fake.store.values()].filter((json) => (JSON.parse(json) as { rows: number[][] }).rows[0][0] === 777.25);
    expect(survivors).toHaveLength(1);
  });

  it('桌面:同名记录只在本机库(已不在最近列表)也先另存', async () => {
    vi.useFakeTimers();
    const fake = memoryDb();
    platform.datasetDb = fake.db;
    const entry = saveSummaryOf('A.csv', [[10], [11], [12], [13], [14]]);
    useData.getState().importMatrix('B.csv', ['x'], [[0.5], [0.75], [1], [1.25], [1.5]]);
    await vi.advanceTimersByTimeAsync(1000);
    // 最近列表已不含 A.csv,但本机库里的 A.csv 已被后续编辑(另一会话/挤出最近列表前)
    useData.setState({ recents: useData.getState().recents.filter((recent) => recent.name !== 'A.csv') });
    fake.store.set('A.csv', JSON.stringify({
      name: 'A.csv', colNames: ['x'], rows: [[555.5], [11], [12], [13], [14]], textCols: [], savedAt: '2026-09-01T00:00:00.000Z',
    }));

    const pending = useAnalyses.getState().restore(entry.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect((JSON.parse(fake.store.get('A.csv')!) as { rows: number[][] }).rows[0][0]).toBe(10);
    const survivors = [...fake.store.values()].filter((json) => (JSON.parse(json) as { rows: number[][] }).rows[0][0] === 555.5);
    expect(survivors).toHaveLength(1);
  });

  it('桌面:本机库读取失败时 fail-closed,不回放快照', async () => {
    const fake = memoryDb();
    platform.datasetDb = fake.db;
    const entry = saveSummaryOf('A.csv', [[10], [11], [12], [13], [14]]);
    useData.getState().importMatrix('B.csv', ['x'], [[0.5], [0.75], [1], [1.25], [1.5]]);
    useData.setState({ recents: useData.getState().recents.filter((recent) => recent.name !== 'A.csv') });
    vi.mocked(fake.db.get).mockRejectedValueOnce(new Error('磁盘 I/O 错误'));
    expect(await useAnalyses.getState().restore(entry.id)).toBe(false);
    expect(useData.getState().model.name).toBe('B.csv');
    expect(useApp.getState().toast).toContain('已取消回看');
  });
});

describe('STORE-03 单槽数据回看前自动保全', () => {
  it('P 图：回看一月记录前，二月计数被自动存为分析记录，可再回看恢复', async () => {
    useData.getState().importCounts('p', '一月不良', [1, 4, 2, 5], 80);
    useApp.setState({ page: 'spc', spcType: 'p' });
    const jan = useAnalyses.getState().saveCurrent()!;
    useData.getState().importCounts('p', '二月不良', [3, 3, 6, 2], 80);
    useApp.setState({ page: 'dashboard', spcType: 'xbar-r' });

    expect(await useAnalyses.getState().restore(jan.id)).toBe(true);
    expect(useData.getState().pModel.name).toBe('一月不良');
    const backup = useAnalyses.getState().saved.find((analysis) => analysis.snapshot.pChartData?.name === '二月不良');
    expect(backup).toBeDefined();
    expect(backup!.snapshot.pChartData!.counts).toEqual([3, 3, 6, 2]);
    expect(useApp.getState().toast).toContain('二月不良');

    // 当前一月数据已由原记录保存：再回看二月备份不应再产生新备份
    const count = useAnalyses.getState().saved.length;
    expect(await useAnalyses.getState().restore(backup!.id)).toBe(true);
    expect(useData.getState().pModel.pdef).toEqual([3, 3, 6, 2]);
    expect(useAnalyses.getState().saved).toHaveLength(count);
  });

  it('C 图同样保全', async () => {
    useData.getState().importCounts('c', '一月缺陷', [2, 3, 1, 4]);
    useApp.setState({ page: 'spc', spcType: 'c' });
    const jan = useAnalyses.getState().saveCurrent()!;
    useData.getState().importCounts('c', '二月缺陷', [5, 6, 7, 8]);
    expect(await useAnalyses.getState().restore(jan.id)).toBe(true);
    expect(useData.getState().cModel.name).toBe('一月缺陷');
    expect(useAnalyses.getState().saved.some((analysis) => analysis.snapshot.cChartData?.name === '二月缺陷')).toBe(true);
  });

  it('帕累托：回看旧记录与示例记录都不丢当前数据', async () => {
    useData.getState().importPareto('一月缺陷', [{ name: '划伤', count: 5 }, { name: '毛刺', count: 3 }]);
    useApp.setState({ page: 'pareto', paretoView: 'pareto' });
    const jan = useAnalyses.getState().saveCurrent()!;
    useData.getState().importPareto('二月缺陷', [{ name: '划伤', count: 99 }]);
    expect(await useAnalyses.getState().restore(jan.id)).toBe(true);
    expect(useData.getState().paretoModel?.name).toBe('一月缺陷');
    expect(useAnalyses.getState().saved.some((analysis) => analysis.snapshot.paretoData?.name === '二月缺陷')).toBe(true);

    // 示例/空态记录回看会 clearPareto:当前三月数据必须先保全
    useData.getState().clearPareto();
    useApp.setState({ page: 'pareto', paretoView: 'pareto', paretoShowDemo: true });
    const demo = useAnalyses.getState().saveCurrent()!;
    useData.getState().importPareto('三月缺陷', [{ name: '裂纹', count: 7 }]);
    expect(await useAnalyses.getState().restore(demo.id)).toBe(true);
    expect(useData.getState().paretoModel).toBeNull();
    expect(useAnalyses.getState().saved.some((analysis) => analysis.snapshot.paretoData?.name === '三月缺陷')).toBe(true);
  });

  it('鱼骨图：页面手录的新根因在回看旧记录前被自动保存', async () => {
    saveFishboneState(fish('旧问题'), false);
    useApp.setState({ page: 'pareto', paretoView: 'fishbone' });
    const old = useAnalyses.getState().saveCurrent()!;
    saveFishboneState(fish('新问题', '本周新增根因'), false);
    useApp.setState({ page: 'dashboard', paretoView: 'pareto' });

    expect(await useAnalyses.getState().restore(old.id)).toBe(true);
    expect(loadFishboneState().data.problem).toBe('旧问题');
    const backup = useAnalyses.getState().saved.find((analysis) => analysis.snapshot.fishboneData?.problem === '新问题');
    expect(backup?.snapshot.fishboneData?.categories[1].causes).toEqual(['本周新增根因']);
    expect(backup?.snapshot.fishboneIsDemo).toBe(false);
  });

  it('记录已满 40 条且当前数据未保存时 fail-closed:取消回看、当前数据不变、不挤掉旧记录', async () => {
    useData.getState().importCounts('p', '一月不良', [1, 4, 2, 5], 80);
    useApp.setState({ page: 'spc', spcType: 'p' });
    const jan = useAnalyses.getState().saveCurrent()!;
    useApp.setState({ page: 'doe' });
    for (let i = 1; i < MAX_SAVED_ANALYSES; i++) useAnalyses.getState().saveCurrent();
    expect(useAnalyses.getState().saved).toHaveLength(MAX_SAVED_ANALYSES);
    useData.getState().importCounts('p', '二月不良', [3, 3, 6, 2], 80);
    useApp.setState({ page: 'dashboard' });
    const ids = useAnalyses.getState().saved.map((analysis) => analysis.id);

    expect(await useAnalyses.getState().restore(jan.id)).toBe(false);
    expect(useData.getState().pModel.name).toBe('二月不良');
    expect(useAnalyses.getState().saved.map((analysis) => analysis.id)).toEqual(ids);
    expect(useApp.getState().toast).toContain('已取消回看');
    expect(useApp.getState().page).toBe('dashboard');
  });

  it('当前是内置示例/空态时不产生多余备份', async () => {
    useData.getState().importCounts('p', '一月不良', [1, 4, 2, 5], 80);
    useApp.setState({ page: 'spc', spcType: 'p' });
    const jan = useAnalyses.getState().saveCurrent()!;
    useData.getState().resetDemo();
    expect(await useAnalyses.getState().restore(jan.id)).toBe(true);
    expect(useAnalyses.getState().saved).toHaveLength(1);
  });
});
