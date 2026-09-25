/**
 * 完整性收口：清库两阶段、active/recent 权威、QPROJ 来源语义与 vault 硬上限。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { MAX_VAULT_DATASETS } from '../../core';
import { platform, type DatasetDb } from '../../platform/adapter';
import {
  CLEAR_RECOVERY_STORAGE_KEY,
  MAX_CLEAR_RECOVERY_BYTES,
  persistClearRecoveryIntent,
  readClearRecoveryMarker,
  recoverPendingClearOperation,
} from '../../platform/clearRecovery';
import { applyProjectJson } from '../../platform/project';
import {
  cancelPendingDatasetWork,
  quiescePendingDatasetWorkForClear,
  resumePendingDatasetWorkAfterClearFailure,
  settlePendingDatasetWrites,
  useData,
} from '../../store/dataStore';
import {
  blockUiForUnresolvedClear,
  clearDurableBusinessDataAtomically,
  removeAllVaultDatasetsBounded,
} from '../shell/OptionsModal';
import { useApp } from '../../store/appStore';

const nativeSetItem = Storage.prototype.setItem;
const nativeRemoveItem = Storage.prototype.removeItem;
const nativeKey = Storage.prototype.key;

function worksheet(name: string, value: number, savedAt = '2026-08-13T00:00:00Z') {
  return { name, colNames: ['x'], rows: [[value], [value + 1]], textCols: [], savedAt };
}

function analysis(datasetName: string, snapshot: Record<string, unknown>) {
  return {
    id: 'a1', kind: 'summary', title: '摘要', datasetName, metric: 'N=2', status: '已完成',
    statusColor: '#000', statusBg: '#fff', createdAt: 1, snapshot,
  };
}

function project(stores: Record<string, string>, vault?: Record<string, string>) {
  return JSON.stringify({
    format: 'quality-platform-project', formatVersion: 1, appVersion: 'legacy', exportedAt: 't',
    stores, ...(vault ? { vault } : {}),
  });
}

function emptyDb(overrides: Partial<DatasetDb> = {}): DatasetDb {
  return {
    async put() {},
    async get() { return null; },
    async list() { return []; },
    async remove() { return false; },
    async clear(opId) { return { opId, committed: true, removed: 0 }; },
    async clearStatus() { return null; },
    async stats() { return { count: 0, total_bytes: 0, path: ':memory:' }; },
    ...overrides,
  };
}

beforeEach(() => {
  platform.datasetDb = null;
  useApp.getState().setBusyOverlay(null);
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
});

afterEach(async () => {
  Storage.prototype.setItem = nativeSetItem;
  Storage.prototype.removeItem = nativeRemoveItem;
  Storage.prototype.key = nativeKey;
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('active 与 recent 的 latest-wins 不变量', () => {
  it('同 tick 编辑后切换会先 flush，返回 A 时仍是最新单元格', async () => {
    useData.getState().importMatrix('A.csv', ['x'], [[1], [2]]);
    useData.getState().importMatrix('B.csv', ['x'], [[10], [20]]);
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);

    vi.useFakeTimers();
    useData.getState().updateCell(0, 0, 99);
    // 不让 0ms timer 有机会自己运行，loadRecent 必须主动 flush。
    expect(await useData.getState().loadRecent('B.csv')).toBe(true);
    expect(useData.getState().model.name).toBe('B.csv');
    const persistedA = JSON.parse(localStorage.getItem('qp-recents-v1')!)
      .find((entry: { name: string }) => entry.name === 'A.csv');
    expect(persistedA.data.rows).toEqual([[99], [2]]);

    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    expect(useData.getState().model.subs.map((row) => row.vals)).toEqual([[99], [2]]);
  });

  it('同 tick flush 的 recent 写入失败时拒绝切换，当前最新值与未保存保护均保留', async () => {
    useData.getState().importMatrix('A.csv', ['x'], [[1], [2]]);
    useData.getState().importMatrix('B.csv', ['x'], [[10], [20]]);
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    Storage.prototype.setItem = function failRecents(key: string, value: string) {
      if (key === 'qp-recents-v1') throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };

    vi.useFakeTimers();
    useData.getState().updateCell(0, 0, 77);
    expect(await useData.getState().loadRecent('B.csv')).toBe(false);
    expect(useData.getState().model.name).toBe('A.csv');
    expect(useData.getState().model.subs[0].vals[0]).toBe(77);
    expect(useData.getState()).toMatchObject({ recentsUnpersisted: true, activeUnpersisted: true });
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).rows).toEqual([[77], [2]]);
  });

  it('桌面端 full recent 超配额退化为轻量引用时，exact A 立即落库前禁止切换', async () => {
    useData.getState().importMatrix('A.csv', ['x'], [[1], [2]]);
    useData.getState().importMatrix('B.csv', ['x'], [[10], [20]]);
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    vi.useFakeTimers();
    const pending = new Map<string, { json: string; resolve: () => void }>();
    const put = vi.fn((name: string, json: string) => new Promise<void>((resolve) => {
      pending.set(name, { json, resolve });
    }));
    platform.datasetDb = emptyDb({ put });
    Storage.prototype.setItem = function rejectOnlyFullRecents(key: string, value: string) {
      if (key === 'qp-recents-v1') {
        const entries = JSON.parse(value) as Array<{ data?: unknown }>;
        if (entries.some((entry) => entry.data !== undefined)) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
      }
      return nativeSetItem.call(this, key, value);
    };

    useData.getState().updateCell(0, 0, 88);
    expect(await useData.getState().loadRecent('B.csv')).toBe(false);
    expect(useData.getState().model.name).toBe('A.csv');
    expect(useData.getState().model.subs[0].vals[0]).toBe(88);
    // 不等 400ms timer 就已入队，载荷是精确最新 A。
    expect(new Set(put.mock.calls.map(([name]) => name))).toEqual(new Set(['A.csv', 'B.csv']));
    expect(JSON.parse(pending.get('A.csv')!.json).rows).toEqual([[88], [2]]);
    expect(useData.getState().activeUnpersisted).toBe(true);

    pending.get('B.csv')!.resolve();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(useData.getState().activeUnpersisted).toBe(true);
    pending.get('A.csv')!.resolve();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(useData.getState().activeUnpersisted).toBe(false);
    expect(await useData.getState().loadRecent('B.csv')).toBe(true);
    expect(useData.getState().model.name).toBe('B.csv');
  });

  it('轻量 recent 对应的 exact SQLite 写入失败时持续 fail-closed', async () => {
    useData.getState().importMatrix('A.csv', ['x'], [[1], [2]]);
    useData.getState().importMatrix('B.csv', ['x'], [[10], [20]]);
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    vi.useFakeTimers();
    platform.datasetDb = emptyDb({ put: vi.fn(async () => { throw new Error('disk failed'); }) });
    Storage.prototype.setItem = function rejectOnlyFullRecents(key: string, value: string) {
      if (key === 'qp-recents-v1') {
        const entries = JSON.parse(value) as Array<{ data?: unknown }>;
        if (entries.some((entry) => entry.data !== undefined)) throw new DOMException('quota', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    };

    useData.getState().updateCell(0, 0, 66);
    expect(await useData.getState().loadRecent('B.csv')).toBe(false);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(await useData.getState().loadRecent('B.csv')).toBe(false);
    expect(useData.getState().model.subs[0].vals[0]).toBe(66);
    expect(useData.getState().activeUnpersisted).toBe(true);
    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('B 触发 light 时会把尚在 400ms 窗口的 A 与 B 一起立即入库', async () => {
    vi.useFakeTimers();
    const pending = new Map<string, {
      json: string;
      resolve: () => void;
      reject: (error: Error) => void;
    }>();
    const put = vi.fn((name: string, json: string) => new Promise<void>((resolve, reject) => {
      pending.set(name, { json, resolve, reject });
    }));
    platform.datasetDb = emptyDb({ put });

    useData.getState().importMatrix('A.csv', ['x'], [[1], [2]]);
    expect(put).not.toHaveBeenCalled(); // A 仍只有 400ms timer
    Storage.prototype.setItem = function rejectBFullRecents(key: string, value: string) {
      if (key === 'qp-recents-v1') {
        const entries = JSON.parse(value) as Array<{ name: string; data?: unknown }>;
        if (entries[0]?.name === 'B.csv' && entries.some((entry) => entry.data !== undefined)) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
      }
      return nativeSetItem.call(this, key, value);
    };

    useData.getState().importMatrix('B.csv', ['x'], [[10], [20]]);
    expect(new Set(put.mock.calls.map(([name]) => name))).toEqual(new Set(['A.csv', 'B.csv']));
    expect(JSON.parse(pending.get('A.csv')!.json).rows).toEqual([[1], [2]]);
    expect(JSON.parse(pending.get('B.csv')!.json).rows).toEqual([[10], [20]]);
    expect(useData.getState().activeUnpersisted).toBe(true);

    pending.get('A.csv')!.resolve();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(useData.getState().activeUnpersisted).toBe(true); // B 仍未 durable
    pending.get('B.csv')!.resolve();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(useData.getState().activeUnpersisted).toBe(false);
  });

  it('B light 的非当前 A exact 写入失败也保留全局未保存保护', async () => {
    vi.useFakeTimers();
    const pending = new Map<string, {
      resolve: () => void;
      reject: (error: Error) => void;
    }>();
    platform.datasetDb = emptyDb({
      put: vi.fn((name: string) => new Promise<void>((resolve, reject) => {
        pending.set(name, { resolve, reject });
      })),
    });
    useData.getState().importMatrix('A.csv', ['x'], [[3], [4]]);
    Storage.prototype.setItem = function rejectBFullRecents(key: string, value: string) {
      if (key === 'qp-recents-v1') {
        const entries = JSON.parse(value) as Array<{ name: string; data?: unknown }>;
        if (entries[0]?.name === 'B.csv' && entries.some((entry) => entry.data !== undefined)) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
      }
      return nativeSetItem.call(this, key, value);
    };
    useData.getState().importMatrix('B.csv', ['x'], [[30], [40]]);

    pending.get('A.csv')!.reject(new Error('A disk failed'));
    pending.get('B.csv')!.resolve();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(useData.getState().model.name).toBe('B.csv');
    expect(useData.getState().activeUnpersisted).toBe(true);
    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('recent 写失败会显式维持未保存状态，阻止切换且同名入口不会回退当前矩阵', async () => {
    Storage.prototype.setItem = function failRecents(key: string, value: string) {
      if (key === 'qp-recents-v1') throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };

    useData.getState().importMatrix('同名.csv', ['x'], [[10], [11]]);
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).rows).toEqual([[10], [11]]);
    expect(useData.getState()).toMatchObject({
      recentsUnpersisted: true,
      activeUnpersisted: true,
    });
    expect(await useData.getState().loadRecent('同名.csv')).toBe(true);
    expect(useData.getState().model.name).toBe('同名.csv');
    expect(useData.getState().model.subs.map((row) => row.vals)).toEqual([[10], [11]]);
    expect(() => useData.getState().importMatrix('别名.csv', ['x'], [[1], [2]]))
      .toThrow(/最近数据集列表尚未保存/);

    Storage.prototype.setItem = nativeSetItem;
    vi.useFakeTimers();
    useData.getState().updateCell(0, 0, 99);
    await vi.runAllTimersAsync();
    expect(useData.getState()).toMatchObject({
      recentsUnpersisted: false,
      activeUnpersisted: false,
    });
    expect(JSON.parse(localStorage.getItem('qp-recents-v1')!)[0].data.rows)
      .toEqual([[99], [11]]);
  });

  it('项目导入在任何写入前拒绝 active 与同名 recent 的不同矩阵', () => {
    const marker = JSON.stringify({ keep: { lsl: 0, tgt: 1, usl: 2 } });
    localStorage.setItem('qp-specs-v1', marker);
    const active = worksheet('A', 100, '2026-08-13T02:00:00Z');
    const stale = worksheet('A', 1, '2026-08-13T01:00:00Z');
    const error = applyProjectJson(project({
      'qp-dataset-v1': JSON.stringify(active),
      'qp-recents-v1': JSON.stringify([{ name: 'A', savedAt: stale.savedAt, data: stale }]),
    }));
    expect(error).toContain('回退旧矩阵');
    expect(localStorage.getItem('qp-specs-v1')).toBe(marker);
  });
});

describe('清库 prepare/commit 与有界删除', () => {
  it.each(['unknown', 'recovery-pending'] as const)(
    '%s 清库结果在 reload 前先建立全局 busy 屏障，reload 抛错也不解除',
    (clearOutcome) => {
      const error = Object.assign(new Error('unresolved'), { clearOutcome });
      const reload = vi.fn(() => {
        expect(useApp.getState().busyOverlay).toMatch(/禁止继续操作/);
        throw new Error('reload unavailable in test host');
      });

      expect(blockUiForUnresolvedClear(error, reload)).toBe(true);
      expect(reload).toHaveBeenCalledOnce();
      expect(useApp.getState().busyOverlay).toMatch(/禁止继续操作/);
    },
  );

  it('明确 not-committed 不触发 reload 或全局阻断', () => {
    const reload = vi.fn();
    const error = Object.assign(new Error('rolled back'), { clearOutcome: 'not-committed' });
    expect(blockUiForUnresolvedClear(error, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(useApp.getState().busyOverlay).toBeNull();
  });

  it('在删除第一个浏览器业务键前已持久化并读回恢复意图', async () => {
    localStorage.setItem('qp-dataset-v1', '{"mustRecover":true}');
    let markerAtFirstDelete: ReturnType<typeof readClearRecoveryMarker> = null;
    let observed = false;
    Storage.prototype.removeItem = function observeFirstBusinessDelete(key: string) {
      if (!observed && key === 'qp-dataset-v1') {
        observed = true;
        markerAtFirstDelete = readClearRecoveryMarker();
      }
      return nativeRemoveItem.call(this, key);
    };
    const clear = vi.fn(async (opId: string) => ({ opId, committed: true as const, removed: 1 }));

    await clearDurableBusinessDataAtomically(emptyDb({ clear }));

    expect(markerAtFirstDelete).toMatchObject({
      phase: 'prepared',
      snapshot: expect.arrayContaining([['qp-dataset-v1', '{"mustRecover":true}']]),
    });
    expect(clear).toHaveBeenCalledOnce();
    expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('底层清理失败前不会销毁未持久化保护', async () => {
    let rejectPut!: (error: Error) => void;
    platform.datasetDb = emptyDb({
      put: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPut = reject; })),
    });
    Storage.prototype.setItem = function failActive(key: string, value: string) {
      if (key === 'qp-dataset-v1') throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };
    useData.getState().importMatrix('待保全.csv', ['x'], [[5], [6]]);
    expect(useData.getState().activeUnpersisted).toBe(true);

    const quiesced = quiescePendingDatasetWorkForClear();
    rejectPut(new Error('disk failed'));
    await quiesced;
    // 模拟 OptionsModal 随后的原子 clear 失败：必须 resume，而不是 commit cancel。
    const clearError = new Error('atomic clear failed');
    const clearDb = emptyDb({ clear: vi.fn().mockRejectedValue(clearError) });
    await expect(removeAllVaultDatasetsBounded(clearDb)).rejects.toBe(clearError);
    resumePendingDatasetWorkAfterClearFailure();
    expect(useData.getState().activeUnpersisted).toBe(true);
    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('浏览器删除到第 N 个失败时恢复原键，且绝不调用 SQLite clear', async () => {
    const originals: Record<string, string> = {
      'qp-dataset-v1': '{"dataset":1}',
      'qp-recents-v1': '[{"recent":1}]',
      'qp-quarantine-v1.corrupt-proof': '原始证据',
    };
    for (const [key, value] of Object.entries(originals)) localStorage.setItem(key, value);
    localStorage.setItem('qp-prefs-v1', '偏好保留');
    const clear = vi.fn(async (opId: string) => ({ opId, committed: true as const, removed: 3 }));
    const db = emptyDb({ clear });
    let removals = 0;
    Storage.prototype.removeItem = function failSecondRemoval(key: string) {
      removals += 1;
      if (removals === 2) throw new Error('remove failed');
      return nativeRemoveItem.call(this, key);
    };

    await expect(clearDurableBusinessDataAtomically(db)).rejects.toThrow(/remove failed.*已恢复/s);
    expect(clear).not.toHaveBeenCalled();
    for (const [key, value] of Object.entries(originals)) expect(localStorage.getItem(key)).toBe(value);
    expect(localStorage.getItem('qp-prefs-v1')).toBe('偏好保留');
  });

  it('浏览器快照读取失败时零修改返回，SQLite 未改动', async () => {
    localStorage.setItem('qp-dataset-v1', '{"keep":true}');
    const clear = vi.fn(async (opId: string) => ({ opId, committed: true as const, removed: 1 }));
    Storage.prototype.key = function failEnumeration() {
      throw new Error('enumeration denied');
    };

    await expect(clearDurableBusinessDataAtomically(emptyDb({ clear })))
      .rejects.toThrow('enumeration denied');
    expect(clear).not.toHaveBeenCalled();
    expect(localStorage.getItem('qp-dataset-v1')).toBe('{"keep":true}');
  });

  it('浏览器删除成功但 SQLite 事务拒绝时恢复全部浏览器键', async () => {
    const originals: Record<string, string> = {
      'qp-dataset-v1': '{"dataset":2}',
      'qp-recents-v1': '[{"recent":2}]',
      'qp-analysis-data-v1': '{"analysis":2}',
      'qp-quarantine-v1.corrupt-proof': '损坏原文',
    };
    for (const [key, value] of Object.entries(originals)) localStorage.setItem(key, value);
    const clear = vi.fn(async () => { throw new Error('sqlite rollback'); });
    const clearStatus = vi.fn(async () => null);

    await expect(clearDurableBusinessDataAtomically(emptyDb({ clear, clearStatus })))
      .rejects.toThrow(/sqlite rollback.*浏览器数据已恢复/s);
    expect(clear).toHaveBeenCalledOnce();
    expect(clearStatus).toHaveBeenCalledOnce();
    for (const [key, value] of Object.entries(originals)) expect(localStorage.getItem(key)).toBe(value);
  });

  it('SQLite 已提交但 clear IPC 回复丢失时，依持久回执完成且不恢复旧 browser', async () => {
    localStorage.setItem('qp-dataset-v1', '{"old":true}');
    let opId = '';
    const clear = vi.fn(async (id: string) => {
      opId = id;
      throw new Error('reply lost');
    });
    const clearStatus = vi.fn(async (id: string) => ({ opId: id, committed: true as const, removed: 4 }));

    await expect(clearDurableBusinessDataAtomically(emptyDb({ clear, clearStatus }))).resolves.toBeUndefined();
    expect(clear).toHaveBeenCalledOnce();
    expect(clearStatus).toHaveBeenCalledWith(opId);
    expect(localStorage.getItem('qp-dataset-v1')).toBeNull();
  });

  it('SQLite 已提交但 marker 删除失败时保持 restart-required，不能放行后续写入', async () => {
    localStorage.setItem('qp-dataset-v1', '{"old":true}');
    const clear = vi.fn(async (opId: string) => ({
      opId, committed: true as const, removed: 1,
    }));
    Storage.prototype.removeItem = function failOnlyRecoveryMarker(key: string) {
      if (key === CLEAR_RECOVERY_STORAGE_KEY) throw new Error('marker remove denied');
      return nativeRemoveItem.call(this, key);
    };

    const error = await clearDurableBusinessDataAtomically(emptyDb({ clear }))
      .then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as { clearOutcome?: unknown }).clearOutcome).toBe('recovery-pending');
    expect(String(error)).toMatch(/SQLite 清库已提交.*写入必须保持暂停/s);
    expect(localStorage.getItem('qp-dataset-v1')).toBeNull();
    expect(readClearRecoveryMarker()?.phase).toBe('browser-cleared');

    Storage.prototype.removeItem = nativeRemoveItem;
    await expect(recoverPendingClearOperation(emptyDb({
      clearStatus: vi.fn(async (opId: string) => ({
        opId, committed: true as const, removed: 1,
      })),
    }))).resolves.toMatchObject({ ready: true, recovered: true, committed: true });
    expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('回执查询也失败时用同 opId 幂等重试裁决 committed', async () => {
    localStorage.setItem('qp-recents-v1', '[{"old":true}]');
    const ids: string[] = [];
    const clear = vi.fn(async (opId: string) => {
      ids.push(opId);
      if (ids.length === 1) throw new Error('first reply lost');
      return { opId, committed: true as const, removed: 2 };
    });
    const clearStatus = vi.fn(async () => { throw new Error('status reply lost'); });

    await expect(clearDurableBusinessDataAtomically(emptyDb({ clear, clearStatus }))).resolves.toBeUndefined();
    expect(clear).toHaveBeenCalledTimes(2);
    expect(ids[0]).toBe(ids[1]);
    expect(localStorage.getItem('qp-recents-v1')).toBeNull();
  });

  it('回执查询与同 opId 重试均无回复时 fail-closed，不谎称回滚或恢复旧 browser', async () => {
    localStorage.setItem('qp-dataset-v1', '{"old":true}');
    const clear = vi.fn(async () => { throw new Error('clear reply lost'); });
    const clearStatus = vi.fn(async () => { throw new Error('status reply lost'); });

    await expect(clearDurableBusinessDataAtomically(emptyDb({ clear, clearStatus })))
      .rejects.toThrow(/状态未知.*不恢复/s);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('qp-dataset-v1')).toBeNull();
    const marker = JSON.parse(localStorage.getItem('qp-clear-recovery-v1') ?? '{}');
    expect(marker.opId).toMatch(/^clear-/);
    expect(marker.snapshot).toEqual(expect.arrayContaining([['qp-dataset-v1', '{"old":true}']]));
  });

  it('明确未提交但 marker 删除失败时也保持 restart-required，避免旧快照覆盖新编辑', async () => {
    localStorage.setItem('qp-dataset-v1', '{"old":true}');
    const clear = vi.fn(async () => { throw new Error('sqlite rollback'); });
    const clearStatus = vi.fn(async () => null);
    Storage.prototype.removeItem = function failOnlyRecoveryMarker(key: string) {
      if (key === CLEAR_RECOVERY_STORAGE_KEY) throw new Error('marker remove denied');
      return nativeRemoveItem.call(this, key);
    };

    const error = await clearDurableBusinessDataAtomically(emptyDb({ clear, clearStatus }))
      .then(() => null, (failure: unknown) => failure);
    expect((error as { clearOutcome?: unknown }).clearOutcome).toBe('recovery-pending');
    expect(localStorage.getItem('qp-dataset-v1')).toBe('{"old":true}');
    expect(readClearRecoveryMarker()?.opId).toMatch(/^clear-/);

    Storage.prototype.removeItem = nativeRemoveItem;
    await expect(recoverPendingClearOperation(emptyDb({ clearStatus }))).resolves.toMatchObject({
      ready: true, recovered: true, committed: false,
    });
    expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('启动时发现 prepared 且回执为空，会恢复崩溃前 browser 快照并清 marker', async () => {
    const marker = persistClearRecoveryIntent('clear-crash-before-db', [
      ['qp-dataset-v1', '{"original":true}'],
      ['qp-recents-v1', '[{"original":true}]'],
    ]);
    localStorage.removeItem('qp-dataset-v1');
    localStorage.removeItem('qp-recents-v1');
    expect(readClearRecoveryMarker()).toEqual(marker);
    const clearStatus = vi.fn(async () => null);

    await expect(recoverPendingClearOperation(emptyDb({ clearStatus }))).resolves.toEqual({
      ready: true, recovered: true, committed: false, error: null,
    });
    expect(clearStatus).toHaveBeenCalledWith('clear-crash-before-db');
    expect(localStorage.getItem('qp-dataset-v1')).toBe('{"original":true}');
    expect(localStorage.getItem('qp-recents-v1')).toBe('[{"original":true}]');
    expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('启动时持久回执确认 committed，会保持 browser 删除并清 marker', async () => {
    persistClearRecoveryIntent('clear-crash-after-commit', [
      ['qp-dataset-v1', '{"mustStayDeleted":true}'],
    ]);
    localStorage.removeItem('qp-dataset-v1');
    const clearStatus = vi.fn(async (opId: string) => ({
      opId, committed: true as const, removed: 8,
    }));

    await expect(recoverPendingClearOperation(emptyDb({ clearStatus }))).resolves.toEqual({
      ready: true, recovered: true, committed: true, error: null,
    });
    expect(localStorage.getItem('qp-dataset-v1')).toBeNull();
    expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('启动时回执不可查询会保留 marker 并 fail-closed', async () => {
    persistClearRecoveryIntent('clear-status-unavailable', [
      ['qp-dataset-v1', '{"original":true}'],
    ]);
    localStorage.removeItem('qp-dataset-v1');
    const result = await recoverPendingClearOperation(emptyDb({
      clearStatus: vi.fn(async () => { throw new Error('db locked'); }),
    }));

    expect(result).toMatchObject({ ready: false, recovered: false, committed: null });
    expect(result.error).toMatch(/无法查询.*恢复记录已保留/);
    expect(localStorage.getItem('qp-dataset-v1')).toBeNull();
    expect(readClearRecoveryMarker()?.opId).toBe('clear-status-unavailable');
  });

  it('损坏或超预算 marker 均阻断且不覆盖原记录', async () => {
    localStorage.setItem(CLEAR_RECOVERY_STORAGE_KEY, '{bad-json');
    const malformed = await recoverPendingClearOperation(emptyDb());
    expect(malformed).toMatchObject({ ready: false, recovered: false });
    expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBe('{bad-json');

    localStorage.removeItem(CLEAR_RECOVERY_STORAGE_KEY);
    const oversized = 'x'.repeat(MAX_CLEAR_RECOVERY_BYTES + 1);
    expect(() => persistClearRecoveryIntent('clear-too-large', [['qp-dataset-v1', oversized]]))
      .toThrow(/过大|上限/);
    expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('marker 写后读回与清理都失败时标记 recovery-pending，不误报零修改可继续', async () => {
    localStorage.setItem('qp-dataset-v1', '{"keep":true}');
    const originalGetItem = Storage.prototype.getItem;
    let markerReads = 0;
    Storage.prototype.getItem = function failMarkerReadback(key: string) {
      // 1=旧 marker 启动裁决，2=persist 前存在性检查，3=set 后读回。
      if (key === CLEAR_RECOVERY_STORAGE_KEY && ++markerReads === 3) {
        throw new Error('marker read denied');
      }
      return originalGetItem.call(this, key);
    };
    Storage.prototype.removeItem = function failMarkerCleanup(key: string) {
      if (key === CLEAR_RECOVERY_STORAGE_KEY) throw new Error('marker cleanup denied');
      return nativeRemoveItem.call(this, key);
    };
    const clear = vi.fn(async (opId: string) => ({
      opId, committed: true as const, removed: 1,
    }));

    const error = await clearDurableBusinessDataAtomically(emptyDb({ clear }))
      .then(() => null, (failure: unknown) => failure);
    expect((error as { clearOutcome?: unknown }).clearOutcome).toBe('recovery-pending');
    expect(String(error)).toMatch(/无法确认清库恢复记录是否已移除/);
    expect(clear).not.toHaveBeenCalled();
    expect(originalGetItem.call(localStorage, 'qp-dataset-v1')).toBe('{"keep":true}');
    expect(originalGetItem.call(localStorage, CLEAR_RECOVERY_STORAGE_KEY)).not.toBeNull();
    Storage.prototype.getItem = originalGetItem;
  });

  it('双存储都成功时才提交，业务键与墓地键清空但偏好保留', async () => {
    localStorage.setItem('qp-dataset-v1', '{}');
    localStorage.setItem('qp-recents-v1', '[]');
    localStorage.setItem('qp-quarantine-v1.corrupt-proof', '证据');
    localStorage.setItem('qp-prefs-v1', '偏好');
    const clear = vi.fn(async (opId: string) => ({ opId, committed: true as const, removed: 3 }));
    const list = vi.fn(async () => { throw new Error('不应 list'); });
    const remove = vi.fn(async () => { throw new Error('不应 remove'); });

    await clearDurableBusinessDataAtomically(emptyDb({ clear, list, remove }));
    expect(clear).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(localStorage.getItem('qp-dataset-v1')).toBeNull();
    expect(localStorage.getItem('qp-recents-v1')).toBeNull();
    expect(localStorage.getItem('qp-quarantine-v1.corrupt-proof')).toBeNull();
    expect(localStorage.getItem('qp-prefs-v1')).toBe('偏好');
  });

  it('清库只发起一次原子 clear，不依赖 list/remove', async () => {
    const clear = vi.fn(async (opId: string) => ({ opId, committed: true as const, removed: 3 }));
    const list = vi.fn(async () => { throw new Error('不应读列表'); });
    const remove = vi.fn(async () => { throw new Error('不应逐项删除'); });
    const db = emptyDb({
      clear,
      list,
      remove,
    });
    await removeAllVaultDatasetsBounded(db);
    expect(clear).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('QPROJ 分析工作表引用语义', () => {
  it('保留合法旧 inline sourceData，同时拒绝双来源和两类名称错配', () => {
    const sourceA = worksheet('A', 1);
    delete (sourceA as { savedAt?: string }).savedAt;
    const inline = project({
      'qp-analyses-v1': JSON.stringify([analysis('A', { sourceData: sourceA })]),
    });
    expect(applyProjectJson(inline)).toBeNull();

    const marker = JSON.stringify({ keep: { lsl: 0, tgt: 1, usl: 2 } });
    const rejects = [
      project({
        'qp-analyses-v1': JSON.stringify([analysis('A', { sourceData: sourceA, sourceDataKey: 'k' })]),
        'qp-analysis-data-v1': JSON.stringify({ k: sourceA }),
      }),
      project({
        'qp-analyses-v1': JSON.stringify([analysis('B', { sourceData: sourceA })]),
      }),
      project({
        'qp-analyses-v1': JSON.stringify([analysis('B', { sourceDataKey: 'k' })]),
        'qp-analysis-data-v1': JSON.stringify({ k: sourceA }),
      }),
    ];
    for (const text of rejects) {
      localStorage.clear();
      localStorage.setItem('qp-specs-v1', marker);
      const error = applyProjectJson(text);
      expect(error).toMatch(/不能同时|datasetName.*name 不一致/);
      expect(localStorage.getItem('qp-specs-v1')).toBe(marker);
    }
  });

  it('现代工作表型分析必须恰有一个来源，旧 SPC 无版本记录仍可依赖同名 recent', () => {
    const modernMissing = project({
      'qp-analyses-v1': JSON.stringify([
        analysis('A', { snapshotVersion: 7, activeVar: 'x' }),
      ]),
    });
    expect(applyProjectJson(modernMissing)).toContain('没有 sourceData 或 sourceDataKey');

    const legacySpc = {
      ...analysis('A', { spcType: 'xbar-r' }),
      kind: 'spc',
    };
    expect(applyProjectJson(project({
      'qp-analyses-v1': JSON.stringify([legacySpc]),
    }))).toBeNull();
  });
});

describe('vault 数量硬上限', () => {
  it('JS 与 Rust 命令边界使用同一 vault 数量上限', () => {
    const rust = readFileSync('src-tauri/src/db.rs', 'utf8');
    const raw = /const MAX_VAULT_DATASETS:\s*usize\s*=\s*([\d_]+);/.exec(rust)?.[1];
    expect(raw, 'Rust vault 上限常量未找到').toBeTruthy();
    expect(Number(raw!.replace(/_/g, ''))).toBe(MAX_VAULT_DATASETS);
  });

  it('JS 在逐项 JSON.parse 前拒绝 cap+1，且不改写当前项目', () => {
    const vault = Object.create(null) as Record<string, string>;
    // 第一项故意不是 JSON；若实现先逐项解析，错误会变成“JSON 解析失败”。
    vault.d0 = '{';
    for (let index = 1; index <= MAX_VAULT_DATASETS; index++) {
      vault[`d${index}`] = JSON.stringify(worksheet(`d${index}`, index));
    }
    const marker = JSON.stringify({ keep: { lsl: 0, tgt: 1, usl: 2 } });
    localStorage.setItem('qp-specs-v1', marker);
    const error = applyProjectJson(project({ 'qp-specs-v1': '{}' }, vault));
    expect(error).toContain('vault 数据集数量');
    expect(error).toContain('上限');
    expect(error).not.toContain('JSON 解析失败');
    expect(localStorage.getItem('qp-specs-v1')).toBe(marker);
  });
});
