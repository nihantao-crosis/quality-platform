/**
 * v1.43 数据完整性第二轮：独立安全副本、bounded latest 队列、
 * SQLite 项目事务/journal、只读 revision 快照。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb, type DatasetImportEntry } from '../../platform/adapter';
import {
  applyProjectText,
  buildProjectJson,
  buildProjectJsonFull,
  recoverPendingProjectImport,
} from '../../platform/project';
import {
  cancelPendingDatasetWork,
  hydrateActiveFromVault,
  initializePersistentData,
  settlePendingDatasetWrites,
  useData,
} from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { useApp } from '../../store/appStore';

function datasetJson(name: string, value: number): string {
  return JSON.stringify({
    name, colNames: ['C1'], rows: [[value], [value + 1]], textCols: [], savedAt: '2026-08-01T00:00:00Z',
  });
}

function baseDb(store = new Map<string, string>()): DatasetDb {
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

function atomicDb(initial: Array<[string, string]> = []) {
  const store = new Map(initial);
  let backup: Map<string, string> | null = null;
  let journal: string | null = null;
  const calls = { begin: 0, commit: 0, rollback: 0, get: 0, list: 0 };
  const db: DatasetDb = {
    ...baseDb(store),
    async get(name) { calls.get += 1; return store.get(name) ?? null; },
    async list() { calls.list += 1; return []; },
    async beginProjectImport(entries: DatasetImportEntry[], pendingStoresJson: string) {
      calls.begin += 1;
      if (journal != null) throw new Error('pending');
      backup = new Map(store);
      journal = pendingStoresJson;
      store.clear();
      for (const entry of entries) store.set(entry.name, entry.json);
    },
    async commitProjectImport() {
      calls.commit += 1;
      backup = null;
      journal = null;
    },
    async rollbackProjectImport() {
      calls.rollback += 1;
      if (backup) {
        store.clear();
        for (const [name, json] of backup) store.set(name, json);
      }
      backup = null;
      journal = null;
    },
    async pendingProjectImport() { return journal; },
  };
  return {
    db, store, calls,
    seedPending(entries: DatasetImportEntry[], stores: Record<string, string>) {
      return db.beginProjectImport!(entries, JSON.stringify(stores));
    },
  };
}

const nativeSetItem = Storage.prototype.setItem;
const nativeRemoveItem = Storage.prototype.removeItem;

beforeEach(() => {
  localStorage.clear();
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useAnalyses.setState({ saved: [], lastError: null });
});

afterEach(async () => {
  Storage.prototype.setItem = nativeSetItem;
  Storage.prototype.removeItem = nativeRemoveItem;
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('回看前安全副本是独立耐久副本', () => {
  it('Web 端 recent 完整副本写失败时，即使共享 active slot 成功也不得报保存成功', () => {
    useData.getState().importMatrix('当前.csv', ['x'], [[1], [2], [3]]);
    Storage.prototype.setItem = function quotaRecent(key: string, value: string) {
      if (key === 'qp-recents-v1' && value.includes('(副本')) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    };
    const saved = useData.getState().saveAsCopy();
    expect(saved.outcome.persisted).toBe(false);
    expect(saved.outcome.archiving).toBe(false);
    // 共享活动槽确实写成了副本，证明测试没有靠 active slot 误放行。
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).name).toBe(saved.name);
  });

  it('桌面端即使 active slot 可写，仍返回不可合并的 SQLite durability', async () => {
    let resolvePut!: () => void;
    const insert = vi.fn(() => new Promise<boolean>((resolve) => { resolvePut = () => resolve(true); }));
    platform.datasetDb = { ...baseDb(), insert };
    useData.getState().importMatrix('当前.csv', ['x'], [[1], [2], [3]]);
    const saved = useData.getState().saveAsCopy();
    expect(saved.outcome.persisted).toBe(false);
    expect(saved.outcome.archiving).toBe(true);
    expect(saved.outcome.durability).toBeInstanceOf(Promise);
    await Promise.resolve();
    expect(insert).toHaveBeenCalledTimes(1);
    resolvePut();
    await expect(saved.outcome.durability).resolves.toBeUndefined();
  });
});

describe('同名大表写队列 bounded latest-wins', () => {
  it('在途未完成时只保留一个 latest，连续编辑不会发起无界 put', async () => {
    vi.useFakeTimers();
    const puts: Array<{ json: string; resolve: () => void }> = [];
    const db = baseDb();
    db.put = vi.fn((_name, json) => new Promise<void>((resolve) => puts.push({ json, resolve })));
    platform.datasetDb = db;
    useData.getState().importMatrix('同名.csv', ['x'], [[1], [2]]);
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    for (const value of [10, 20, 30]) {
      useData.getState().updateCell(0, 0, value);
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(1);
    }
    puts[0].resolve();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(puts).toHaveLength(2);
    expect(JSON.parse(puts[1].json).rows[0][0]).toBe(30);
    puts[1].resolve();
    await settlePendingDatasetWrites();
  });
});

describe('跨数据集未持久化快照保全', () => {
  it('A 归档失败后切到已落盘 B，仍阻止关闭并在导出时重试精确 A', async () => {
    const vault = new Map<string, string>();
    const db = baseDb(vault);
    let failFirstA = true;
    db.put = vi.fn(async (name, json) => {
      if (name === '大表A' && failFirstA) {
        failFirstA = false;
        throw new Error('disk full');
      }
      vault.set(name, json);
    });
    platform.datasetDb = db;
    Storage.prototype.setItem = function quotaForAAndFullRecents(key: string, value: string) {
      if (key === 'qp-dataset-v1') {
        const parsed = JSON.parse(value) as { name?: string };
        if (parsed.name === '大表A') throw new DOMException('quota', 'QuotaExceededError');
      }
      if (key === 'qp-recents-v1') {
        const parsed = JSON.parse(value) as Array<{ data?: unknown }>;
        if (parsed.some((entry) => entry.data !== undefined)) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
      }
      return nativeSetItem.call(this, key, value);
    };

    const a = useData.getState().importMatrix('大表A', ['x'], [[11], [12], [13]]);
    expect(a.archiving).toBe(true);
    await expect(a.durability).rejects.toThrow('disk full');

    const b = useData.getState().importMatrix('小表B', ['x'], [[21], [22]]);
    expect(b.persisted).toBe(true);
    expect(useData.getState().model.name).toBe('小表B');
    expect(useData.getState().activeUnpersisted).toBe(true);

    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);
    expect(unload.defaultPrevented).toBe(true);

    const project = JSON.parse(await buildProjectJsonFull('1.43.0')) as {
      vault: Record<string, string>;
    };
    expect(JSON.parse(project.vault['大表A']).rows).toEqual([[11], [12], [13]]);
    expect(JSON.parse(vault.get('大表A')!).rows).toEqual([[11], [12], [13]]);
    expect(useData.getState().activeUnpersisted).toBe(false);
  });

  it('同名 A1 的迟到成功不得清掉更新 A2，只有 A2 落盘后解除警告', async () => {
    const puts: Array<{ json: string; resolve: () => void }> = [];
    const db = baseDb();
    db.put = vi.fn((_name, json) => new Promise<void>((resolve) => puts.push({ json, resolve })));
    platform.datasetDb = db;
    Storage.prototype.setItem = function quotaForSameName(key: string, value: string) {
      if (key === 'qp-dataset-v1' && JSON.parse(value).name === '同名A') {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    };

    const a1 = useData.getState().importMatrix('同名A', ['x'], [[1], [2]]);
    const a2 = useData.getState().importMatrix('同名A', ['x'], [[101], [102]]);
    expect(puts).toHaveLength(1);

    puts[0].resolve();
    await expect(a1.durability).resolves.toBeUndefined();
    for (let spin = 0; spin < 8 && puts.length < 2; spin++) await Promise.resolve();
    expect(puts).toHaveLength(2);
    expect(JSON.parse(puts[1].json).rows).toEqual([[101], [102]]);
    expect(useData.getState().activeUnpersisted).toBe(true);

    puts[1].resolve();
    await expect(a2.durability).resolves.toBeUndefined();
    expect(useData.getState().activeUnpersisted).toBe(false);
  });
});

describe('不同名 vault 全局执行器与背压', () => {
  it('同时只运行 2 个不同名 put，其余有界排队', async () => {
    vi.useFakeTimers();
    const puts: Array<{ name: string; resolve: () => void }> = [];
    const store = new Map<string, string>();
    const db = baseDb(store);
    db.put = vi.fn((name, json) => new Promise<void>((resolve) => {
      puts.push({ name, resolve: () => { store.set(name, json); resolve(); } });
    }));
    platform.datasetDb = db;
    for (let index = 0; index < 6; index++) {
      useData.getState().importMatrix(`异名-${index}.csv`, ['x'], [[index], [index + 1]]);
    }
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    let resolved = 0;
    while (resolved < 6) {
      puts[resolved].resolve();
      resolved += 1;
      for (let spin = 0; spin < 8; spin++) await Promise.resolve();
      expect(puts.length).toBeLessThanOrEqual(resolved + 2);
    }
    await settlePendingDatasetWrites();
    expect(db.put).toHaveBeenCalledTimes(6);
  });

  it('400ms 防抖窗口内的不同名完整快照也限制数量，超限可见且不进 put', async () => {
    vi.useFakeTimers();
    const puts: Array<{ resolve: () => void }> = [];
    const db = baseDb();
    db.put = vi.fn(() => new Promise<void>((resolve) => puts.push({ resolve })));
    platform.datasetDb = db;
    for (let index = 0; index < 20; index++) {
      useData.getState().importMatrix(`timer-${index}.csv`, ['x'], [[index], [index + 1]]);
    }
    expect(useApp.getState().toast).toContain('归档队列已满');
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    let resolved = 0;
    // 失败保全预算（12 份）比 timer 数量上限（16）更严，因此最多 12 份真正进 put。
    while (resolved < 12) {
      puts[resolved].resolve();
      resolved += 1;
      for (let spin = 0; spin < 8; spin++) await Promise.resolve();
    }
    await settlePendingDatasetWrites();
    expect(db.put).toHaveBeenCalledTimes(12);
  });

  it('失败副本保全预算满后阻止新归档，不静默驱逐已保留副本', async () => {
    vi.useFakeTimers();
    const puts: Array<{ reject: (error: Error) => void }> = [];
    const db = baseDb();
    db.put = vi.fn(() => new Promise<void>((_resolve, reject) => puts.push({ reject })));
    platform.datasetDb = db;
    for (let index = 0; index < 13; index++) {
      useData.getState().importMatrix(`fail-${index}.csv`, ['x'], [[index], [index + 1]]);
    }
    await vi.advanceTimersByTimeAsync(400);
    let rejected = 0;
    while (rejected < 12) {
      puts[rejected].reject(new Error('disk full'));
      rejected += 1;
      for (let spin = 0; spin < 8; spin++) await Promise.resolve();
    }
    await settlePendingDatasetWrites();
    expect(db.put).toHaveBeenCalledTimes(12);
    expect(useApp.getState().toast).toContain('归档队列已满');

    useData.getState().importMatrix('预算满后.csv', ['x'], [[1], [2]]);
    await vi.advanceTimersByTimeAsync(400);
    expect(db.put).toHaveBeenCalledTimes(12);
  });

  it('失败归档在导出 flush 重试成功后正确释放计数，不再第三次重放', async () => {
    vi.useFakeTimers();
    const store = new Map<string, string>();
    const puts: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const db = baseDb(store);
    db.put = vi.fn((name, json) => new Promise<void>((resolve, reject) => puts.push({
      resolve: () => { store.set(name, json); resolve(); }, reject,
    })));
    platform.datasetDb = db;
    useData.getState().importMatrix('重试.csv', ['x'], [[1], [2]]);
    await vi.advanceTimersByTimeAsync(400);
    puts[0].reject(new Error('first failure'));
    for (let spin = 0; spin < 8; spin++) await Promise.resolve();

    const firstExport = buildProjectJsonFull('1.43.0');
    for (let spin = 0; spin < 20 && puts.length < 2; spin++) await Promise.resolve();
    expect(puts).toHaveLength(2);
    puts[1].resolve();
    await firstExport;
    await buildProjectJsonFull('1.43.0');
    expect(db.put).toHaveBeenCalledTimes(2);
  });
});

describe('活动引用异步恢复时序', () => {
  it('旧 hydrate 失败不得删除等待期间写入的新 active-ref', async () => {
    let rejectGet!: (error: Error) => void;
    const db = baseDb();
    db.get = vi.fn(() => new Promise<string | null>((_resolve, reject) => { rejectGet = reject; }));
    platform.datasetDb = db;
    localStorage.setItem('qp-active-ref-v1', '旧引用');
    const hydration = hydrateActiveFromVault();
    await Promise.resolve();
    localStorage.setItem('qp-active-ref-v1', '新引用');
    rejectGet(new Error('old read failed'));
    await expect(hydration).resolves.toBe(false);
    expect(localStorage.getItem('qp-active-ref-v1')).toBe('新引用');
  });

  it('同一 active-ref 的瞬时 IPC 拒绝必须保留，只有明确 null 才删除', async () => {
    const db = baseDb();
    db.get = vi.fn(async () => { throw new Error('database is temporarily locked'); });
    platform.datasetDb = db;
    localStorage.setItem('qp-active-ref-v1', '待恢复');
    await expect(hydrateActiveFromVault()).resolves.toBe(false);
    expect(localStorage.getItem('qp-active-ref-v1')).toBe('待恢复');

    db.get = vi.fn(async () => null);
    await expect(hydrateActiveFromVault()).resolves.toBe(false);
    expect(localStorage.getItem('qp-active-ref-v1')).toBeNull();
  });

  it('读成功但结构损坏会隔离原文，并停用当前坏引用', async () => {
    const corrupt = JSON.stringify({ name: '坏活动', colNames: ['x'], rows: [[null]], textCols: [], savedAt: 't' });
    const db = baseDb();
    db.get = vi.fn(async () => corrupt);
    platform.datasetDb = db;
    localStorage.setItem('qp-active-ref-v1', '坏活动');
    await expect(hydrateActiveFromVault()).resolves.toBe(false);
    expect(localStorage.getItem('qp-active-ref-v1')).toBeNull();
    const quarantine = JSON.parse(localStorage.getItem('qp-quarantine-v1')!);
    expect(quarantine['qp-dataset-v1'].raw).toBe(corrupt);
    expect(quarantine['qp-dataset-v1'].detail).toContain('SQLite 活动数据集');
  });

  it('启动屏障会等待活动数据恢复，瞬时读取失败时保持阻断而不是挂载半项目', async () => {
    let resolveGet!: (json: string | null) => void;
    const db = baseDb();
    db.get = vi.fn(() => new Promise<string | null>((resolve) => { resolveGet = resolve; }));
    platform.datasetDb = db;
    localStorage.setItem('qp-active-ref-v1', '待恢复');
    let settled = false;
    const startup = initializePersistentData().then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveGet(datasetJson('待恢复', 5));
    await expect(startup).resolves.toMatchObject({ ready: true, hydrated: true, reloadRequired: false });

    db.get = vi.fn(async () => { throw new Error('database locked'); });
    localStorage.setItem('qp-active-ref-v1', '仍待恢复');
    await expect(initializePersistentData()).resolves.toMatchObject({
      ready: false,
      hydrated: false,
      reloadRequired: false,
    });
    expect(localStorage.getItem('qp-active-ref-v1')).toBe('仍待恢复');
  });

  it('pending journal 检查失败时启动屏障保持不可编辑', async () => {
    const db = baseDb();
    db.beginProjectImport = vi.fn(async () => {});
    db.commitProjectImport = vi.fn(async () => {});
    db.rollbackProjectImport = vi.fn(async () => {});
    db.pendingProjectImport = vi.fn(async () => { throw new Error('sqlite unavailable'); });
    platform.datasetDb = db;
    await expect(initializePersistentData()).resolves.toMatchObject({
      ready: false,
      hydrated: false,
      reloadRequired: false,
      error: expect.stringContaining('检查未完成项目导入失败'),
    });
  });

  it('localStorage 有效版本 savedAt 更新时不被旧 SQLite ref 覆盖', async () => {
    const local = JSON.stringify({
      name: '同名活动', colNames: ['C1'], rows: [[99], [100]], textCols: [], savedAt: '2026-08-02T00:00:00Z',
    });
    const oldVault = JSON.stringify({
      name: '同名活动', colNames: ['C1'], rows: [[1], [2]], textCols: [], savedAt: '2026-08-01T00:00:00Z',
    });
    localStorage.setItem('qp-dataset-v1', local);
    localStorage.setItem('qp-active-ref-v1', '同名活动');
    platform.datasetDb = { ...baseDb(), get: vi.fn(async () => oldVault) };
    await expect(initializePersistentData()).resolves.toMatchObject({ ready: true, hydrated: true });
    expect(useData.getState().model.subs.map((row) => row.vals[0])).toEqual([99, 100]);
    expect(localStorage.getItem('qp-active-ref-v1')).toBeNull();
  });

  it('localStorage/SQLite savedAt 相同但内容不同时保留双副本并阻止启动', async () => {
    localStorage.setItem('qp-dataset-v1', datasetJson('冲突集', 50));
    localStorage.setItem('qp-active-ref-v1', '冲突集');
    platform.datasetDb = { ...baseDb(), get: vi.fn(async () => datasetJson('冲突集', 1)) };
    await expect(initializePersistentData()).resolves.toMatchObject({
      ready: false,
      hydrated: false,
      error: expect.stringContaining('savedAt 无法确定新旧'),
    });
    expect(localStorage.getItem('qp-active-ref-v1')).toBe('冲突集');
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).rows[0][0]).toBe(50);
  });

  it('新 localStorage 已写入但旧 ref 删除失败时不报持久成功', () => {
    localStorage.setItem('qp-active-ref-v1', '旧引用');
    Storage.prototype.removeItem = function retainActiveRef(key: string) {
      if (key === 'qp-active-ref-v1') return;
      return nativeRemoveItem.call(this, key);
    };
    const outcome = useData.getState().importMatrix('新本地.csv', ['x'], [[1], [2]]);
    expect(outcome.persisted).toBe(false);
    expect(outcome.rejected).toContain('未能删除');
    expect(useData.getState().activeUnpersisted).toBe(true);
    expect(localStorage.getItem('qp-active-ref-v1')).toBe('旧引用');
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).name).toBe('新本地.csv');
  });
});

describe('能力风险确认快照对称', () => {
  it('新记录保存/恢复指纹，旧记录明确回落 null 而不继承当前状态', async () => {
    useData.getState().importMatrix('能力.csv', ['x1', 'x2'], [[1, 2], [2, 3], [3, 4], [4, 5]]);
    useApp.setState({ page: 'capability', capabilityWarningAcknowledgement: 'risk-fingerprint-v1' });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved?.snapshot.capabilityWarningAcknowledgement).toBe('risk-fingerprint-v1');

    useApp.setState({ capabilityWarningAcknowledgement: 'newer' });
    await expect(useAnalyses.getState().restore(saved!.id)).resolves.toBe(true);
    expect(useApp.getState().capabilityWarningAcknowledgement).toBe('risk-fingerprint-v1');

    const legacy = structuredClone(saved!);
    legacy.id = 'legacy-capability';
    delete legacy.snapshot.capabilityWarningAcknowledgement;
    useAnalyses.setState({ saved: [legacy], lastError: null });
    useApp.setState({ capabilityWarningAcknowledgement: 'must-not-leak' });
    await expect(useAnalyses.getState().restore(legacy.id)).resolves.toBe(true);
    expect(useApp.getState().capabilityWarningAcknowledgement).toBeNull();
  });
});

describe('QPROJ SQLite 单事务 + journal', () => {
  it('生产原子接口不 list/get 全库到 JS，直接精确替换并提交', async () => {
    const fake = atomicDb([['旧集', datasetJson('旧集', 1)]]);
    platform.datasetDb = fake.db;
    localStorage.setItem('qp-specs-v1', JSON.stringify({ 旧: { lsl: 1, tgt: 2, usl: 3 } }));
    const incoming = datasetJson('新集', 9);
    const result = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': '{}' }, vault: { 新集: incoming },
    }));
    expect(result.error).toBeNull();
    expect(result.lockRequired).toBe(false);
    expect(fake.calls).toMatchObject({ begin: 1, commit: 1, rollback: 0, get: 0, list: 0 });
    expect([...fake.store.keys()]).toEqual(['新集']);
    expect(localStorage.getItem('qp-specs-v1')).toBe('{}');
  });

  it('commit 已耐久但 IPC reject 时复查 pending=null，前向确保 stores 而不回滚新 vault', async () => {
    const fake = atomicDb([['旧集', datasetJson('旧集', 1)]]);
    platform.datasetDb = fake.db;
    const durableCommit = fake.db.commitProjectImport!.bind(fake.db);
    fake.db.commitProjectImport = vi.fn(async () => {
      await durableCommit();
      throw new Error('IPC reply lost after commit');
    });
    const targetSpecs = JSON.stringify({ 新集: { lsl: 1, tgt: 2, usl: 3 } });
    const result = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': targetSpecs }, vault: { 新集: datasetJson('新集', 9) },
    }));
    expect(result.error).toBeNull();
    expect(localStorage.getItem('qp-specs-v1')).toBe(targetSpecs);
    expect(fake.store.has('新集')).toBe(true);
    expect(fake.store.has('旧集')).toBe(false);
    expect(fake.calls.rollback).toBe(0);
    expect(await fake.db.pendingProjectImport!()).toBeNull();
  });

  it('commit reject 后状态查询也失败时 fail-closed，不猜测回滚并保留双 journal', async () => {
    const fake = atomicDb([['旧集', datasetJson('旧集', 1)]]);
    platform.datasetDb = fake.db;
    fake.db.commitProjectImport = vi.fn(async () => { throw new Error('commit reply lost'); });
    fake.db.pendingProjectImport = vi.fn()
      .mockResolvedValueOnce(null) // 导入前启动检查
      .mockRejectedValueOnce(new Error('status unavailable'));
    const targetSpecs = JSON.stringify({ 新集: { lsl: 1, tgt: 2, usl: 3 } });
    const result = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': targetSpecs }, vault: { 新集: datasetJson('新集', 9) },
    }));
    expect(result.error).toContain('无法确认 SQLite journal 状态');
    expect(result.lockRequired).toBe(true);
    expect(fake.calls.rollback).toBe(0);
    expect(localStorage.getItem('qp-specs-v1')).toBe(targetSpecs);
    expect([...Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))]
      .some((key) => key?.includes('project-import-journal'))).toBe(true);
  });

  it('begin reject 后状态查询也失败时返回必须锁定，保留 Web journal', async () => {
    const fake = atomicDb([['旧集', datasetJson('旧集', 1)]]);
    platform.datasetDb = fake.db;
    fake.db.beginProjectImport = vi.fn(async () => { throw new Error('begin reply lost'); });
    fake.db.pendingProjectImport = vi.fn()
      .mockResolvedValueOnce(null) // 导入前启动检查
      .mockRejectedValueOnce(new Error('status unavailable'));
    const result = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': '{}' }, vault: { 新集: datasetJson('新集', 9) },
    }));
    expect(result.error).toContain('无法确认 journal 状态');
    expect(result.lockRequired).toBe(true);
    expect(fake.calls.rollback).toBe(0);
    expect([...Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))]
      .some((key) => key?.includes('project-import-journal'))).toBe(true);
  });

  it('commit reject 后 pending 仍存在时先耐久 rollback-intent，再完整回滚两层', async () => {
    const oldVault = datasetJson('旧集', 1);
    const fake = atomicDb([['旧集', oldVault]]);
    platform.datasetDb = fake.db;
    fake.db.commitProjectImport = vi.fn(async () => { throw new Error('commit did not happen'); });
    const oldSpecs = JSON.stringify({ 旧集: { lsl: 1, tgt: 2, usl: 3 } });
    localStorage.setItem('qp-specs-v1', oldSpecs);
    const result = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': '{}' }, vault: { 新集: datasetJson('新集', 9) },
    }));
    expect(result.error).toContain('已完整回滚');
    expect(result.lockRequired).toBe(false);
    expect(fake.calls.rollback).toBe(1);
    expect(localStorage.getItem('qp-specs-v1')).toBe(oldSpecs);
    expect(fake.store.get('旧集')).toBe(oldVault);
    expect(fake.store.has('新集')).toBe(false);
  });

  it('localStorage 写失败时调用 Rust rollback，旧 vault 无需经过 JS 复制', async () => {
    const old = datasetJson('旧集', 1);
    const fake = atomicDb([['旧集', old]]);
    platform.datasetDb = fake.db;
    localStorage.setItem('qp-specs-v1', '{}');
    Storage.prototype.setItem = function failImportedStore(key: string, value: string) {
      if (key === 'qp-specs-v1' && value.includes('新集')) throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };
    const result = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': JSON.stringify({ 新集: { lsl: 1, tgt: 2, usl: 3 } }) },
      vault: { 新集: datasetJson('新集', 9) },
    }));
    expect(result.error).toContain('完整回滚');
    expect(fake.calls.rollback).toBe(1);
    expect(fake.store.get('旧集')).toBe(old);
    expect(fake.store.has('新集')).toBe(false);
  });

  it('DB 回滚已成功但 Web journal 清理失败时保留 rolled-back，重启不得误前向新 stores', async () => {
    const oldVault = datasetJson('旧集', 1);
    const fake = atomicDb([['旧集', oldVault]]);
    platform.datasetDb = fake.db;
    const oldSpecs = JSON.stringify({ 旧集: { lsl: 1, tgt: 2, usl: 3 } });
    const newSpecs = JSON.stringify({ 新集: { lsl: 10, tgt: 20, usl: 30 } });
    localStorage.setItem('qp-specs-v1', oldSpecs);
    Storage.prototype.setItem = function failTarget(key: string, value: string) {
      if (key === 'qp-specs-v1' && value === newSpecs) throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function retainJournal(key: string) {
      if (key.includes('project-import-journal')) return;
      return nativeRemoveItem.call(this, key);
    };
    const result = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': newSpecs }, vault: { 新集: datasetJson('新集', 9) },
    }));
    expect(result.error).toContain('journal');
    expect(fake.calls.rollback).toBe(1);
    expect(fake.store.get('旧集')).toBe(oldVault);
    expect(localStorage.getItem('qp-specs-v1')).toBe(oldSpecs);
    const journalKey = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
      .find((key) => key?.includes('project-import-journal'))!;
    expect(JSON.parse(localStorage.getItem(journalKey)!).phase).toBe('rolled-back');

    Storage.prototype.setItem = nativeSetItem;
    Storage.prototype.removeItem = nativeRemoveItem;
    const recovered = await recoverPendingProjectImport();
    expect(recovered.recovered).toBe(false);
    expect(recovered.reloadRequired).toBe(true);
    expect(recovered.error).toContain('已完整回滚');
    expect(localStorage.getItem('qp-specs-v1')).toBe(oldSpecs);
    expect(fake.store.get('旧集')).toBe(oldVault);
    expect(fake.store.has('新集')).toBe(false);
  });

  it('进程中断 journal 可前向完成 stores 并清理标记', async () => {
    const fake = atomicDb([['旧集', datasetJson('旧集', 1)]]);
    platform.datasetDb = fake.db;
    await fake.seedPending(
      [{ name: '新集', json: datasetJson('新集', 9), savedAt: 't' }],
      { 'qp-specs-v1': '{}' },
    );
    const recovered = await recoverPendingProjectImport();
    expect(recovered).toEqual({ recovered: true, error: null, reloadRequired: true });
    expect(localStorage.getItem('qp-specs-v1')).toBe('{}');
    expect(fake.calls.commit).toBe(1);
    expect(await fake.db.pendingProjectImport!()).toBeNull();
  });

  it('崩溃恢复时 target stores 仍写不下，会恢复 journal 中的旧 stores 并回滚 vault', async () => {
    const oldVault = datasetJson('旧集', 1);
    const fake = atomicDb([['旧集', oldVault]]);
    platform.datasetDb = fake.db;
    const oldSpecs = JSON.stringify({ 旧集: { lsl: 1, tgt: 2, usl: 3 } });
    const newSpecs = JSON.stringify({ 新集: { lsl: 10, tgt: 20, usl: 30 } });
    localStorage.setItem('qp-specs-v1', oldSpecs);
    const previous = Object.fromEntries([
      'qp-dataset-v1', 'qp-recents-v1', 'qp-attr-v1', 'qp-specs-v1', 'qp-fishbone-v1',
      'qp-analyses-v1', 'qp-analysis-data-v1', 'qp-pareto-v1', 'qp-copy-sequences-v1',
      'qp-quarantine-v1', 'qp-prefs-v1', 'qp-aql-state-v1', 'qp-active-ref-v1',
    ].map((key) => [key, key === 'qp-specs-v1' ? oldSpecs : null]));
    await fake.db.beginProjectImport!(
      [{ name: '新集', json: datasetJson('新集', 9), savedAt: 't' }],
      JSON.stringify({ version: 1, target: { 'qp-specs-v1': newSpecs }, previous }),
    );
    // 模拟进程在 localStorage 写到一半后退出。
    localStorage.setItem('qp-specs-v1', newSpecs);
    Storage.prototype.setItem = function stillFull(key: string, value: string) {
      if (key === 'qp-specs-v1' && value === newSpecs) throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };
    const recovered = await recoverPendingProjectImport();
    expect(recovered.recovered).toBe(false);
    expect(recovered.error).toContain('已完整回滚');
    expect(localStorage.getItem('qp-specs-v1')).toBe(oldSpecs);
    expect(fake.store.get('旧集')).toBe(oldVault);
    expect(fake.store.has('新集')).toBe(false);
  });

  it('本地新值与旧值都因配额写不下时保留 SQLite journal，空间恢复后可重试', async () => {
    const oldVault = datasetJson('旧集', 1);
    const fake = atomicDb([['旧集', oldVault]]);
    platform.datasetDb = fake.db;
    const oldSpecs = JSON.stringify({ 旧集: { lsl: 1, tgt: 2, usl: 3 } });
    const newSpecs = JSON.stringify({ 新集: { lsl: 10, tgt: 20, usl: 30 } });
    localStorage.setItem('qp-specs-v1', oldSpecs);
    Storage.prototype.setItem = function noRoomForEitherVersion(key: string, value: string) {
      if (key === 'qp-specs-v1' && (value === oldSpecs || value === newSpecs)) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    };

    const result = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': newSpecs }, vault: { 新集: datasetJson('新集', 9) },
    }));
    expect(result.error).toContain('journal');
    expect(result.error).toContain('已保留');
    expect(fake.calls.rollback).toBe(0);
    expect(await fake.db.pendingProjectImport!()).not.toBeNull();
    expect(fake.store.has('新集')).toBe(true);
    expect(fake.store.has('旧集')).toBe(false);

    Storage.prototype.setItem = nativeSetItem;
    const recovered = await recoverPendingProjectImport();
    expect(recovered).toEqual({ recovered: true, error: null, reloadRequired: true });
    expect(fake.calls.commit).toBe(1);
    expect(fake.calls.rollback).toBe(0);
    expect(await fake.db.pendingProjectImport!()).toBeNull();
    expect(localStorage.getItem('qp-specs-v1')).toBe(newSpecs);
  });
});

describe('Web stores staging journal 与配额安全顺序', () => {
  it('QPROJ 帕累托与普通导入共用 50,000 类别和 32,768 名称字符上限', async () => {
    const tooMany = Array.from({ length: 50_001 }, (_, index) => ({ name: `C${index}`, count: 1 }));
    const categoryResult = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-pareto-v1': JSON.stringify({ name: '帕累托', rows: tooMany }) },
    }));
    expect(categoryResult.error).toContain('50,000');

    const nameResult = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: {
        'qp-pareto-v1': JSON.stringify({
          name: '帕累托', rows: [{ name: 'x'.repeat(32_769), count: 1 }],
        }),
      },
    }));
    expect(nameResult.error).toContain('32,768');
  });

  it('无 DB 逐键写中断且当场回滚也失败时，启动屏障前向完成而不挂载混合 stores', async () => {
    const oldSpecs = JSON.stringify({ 旧: { lsl: 1, tgt: 2, usl: 3 } });
    const newSpecs = JSON.stringify({ 新: { lsl: 10, tgt: 20, usl: 30 } });
    const targetPareto = JSON.stringify({ name: '新帕累托', rows: [{ name: 'A', count: 2 }] });
    localStorage.setItem('qp-specs-v1', oldSpecs);
    Storage.prototype.setItem = function crashAndNoRollback(key: string, value: string) {
      if (key === 'qp-specs-v1' && (value === oldSpecs || value === newSpecs)) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    };
    const imported = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': newSpecs, 'qp-pareto-v1': targetPareto },
    }));
    expect(imported.error).toContain('journal');
    const partialExport = JSON.parse(buildProjectJson('1.43.0', true));
    expect(Object.keys(partialExport.stores).some((key) => key.includes('project-import-journal'))).toBe(false);

    Storage.prototype.setItem = nativeSetItem;
    const startup = await initializePersistentData();
    expect(startup).toMatchObject({ ready: false, reloadRequired: true });
    expect(localStorage.getItem('qp-specs-v1')).toBe(newSpecs);
    expect(localStorage.getItem('qp-pareto-v1')).toBe(targetPareto);
    expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
      .some((key) => key?.includes('project-import-journal'))).toBe(false);
  });

  // fix2609 TESTS-01:「在 journal 保护下先释放目标缺失的大键」已迁到 fix2609_G0-tests.test.ts。
  // 留在这里时它只在前序成功导入把 appStore 模块级 prefsPersistenceSuspended 置真(本文件无从复位)
  // 之后才通过;单独文件保证在「prefs 与 AQL 账本真实落盘」的正常应用状态下验证释放顺序。
});

describe('完整项目导出的一致只读快照', () => {
  it('使用 revision+datasets 单次快照，不再 list 后逐项 get', async () => {
    const json = datasetJson('快照集', 5);
    const db = baseDb();
    db.list = vi.fn(async () => { throw new Error('不应调用 list'); });
    db.get = vi.fn(async () => { throw new Error('不应调用 get'); });
    db.readSnapshot = vi.fn(async (request) => {
      expect(request.excludeNames).toEqual([]);
      expect(request.forceIncludeName).toBeNull();
      expect(request.maxJsonBytes).toBeGreaterThan(0);
      return {
      revision: 42,
      datasets: [{ name: '快照集', json, saved_at: 't', bytes: json.length }],
      };
    });
    platform.datasetDb = db;
    localStorage.setItem('qp-specs-v1', '{}');
    localStorage.setItem('qp-prefs-v1', '{}');
    const project = JSON.parse(await buildProjectJsonFull('1.43.0'));
    expect(project.vaultRevision).toBe(42);
    expect(project.vault['快照集']).toBe(json);
    expect(db.list).not.toHaveBeenCalled();
    expect(db.get).not.toHaveBeenCalled();
  });

  it('只读快照未完成时工作表写入暂存(fix2609j GAP-7-15 不再抛未捕获异常)，成功或失败后都释放锁并应用', async () => {
    let resolveSnapshot!: (value: { revision: number; datasets: never[] }) => void;
    const db = baseDb();
    db.readSnapshot = vi.fn(() => new Promise<{ revision: number; datasets: never[] }>((resolve) => {
      resolveSnapshot = resolve;
    }));
    platform.datasetDb = db;
    localStorage.setItem('qp-specs-v1', '{}');
    localStorage.setItem('qp-prefs-v1', '{}');
    const exporting = buildProjectJsonFull('1.43.0');
    for (let i = 0; i < 20 && !resolveSnapshot; i++) await Promise.resolve();
    const before = useData.getState().model.subs[0].vals[0];
    expect(() => useData.getState().updateCell(0, 0, 9)).not.toThrow();
    expect(useData.getState().model.subs[0].vals[0]).toBe(before); // 快照期间数据集不变
    // 第二个导出在中央互斥处快速拒绝；绝不能运行 cleanup 释放第一个 owner。
    await expect(buildProjectJsonFull('1.43.0')).rejects.toThrow('已有项目导出正在进行');
    expect(useData.getState().model.subs[0].vals[0]).toBe(before);
    expect(db.readSnapshot).toHaveBeenCalledTimes(1);
    resolveSnapshot({ revision: 7, datasets: [] });
    await expect(exporting).resolves.toContain('"vaultRevision": 7');
    expect(useData.getState().model.subs[0].vals[0]).toBe(9); // 租约释放后暂存编辑已应用
    db.readSnapshot = vi.fn(async () => { throw new Error('snapshot failed'); });
    await expect(buildProjectJsonFull('1.43.0')).rejects.toThrow('snapshot failed');
    expect(() => useData.getState().updateCell(0, 0, 8)).not.toThrow();
    expect(useData.getState().model.subs[0].vals[0]).toBe(8);
  });
});
