/**
 * fix2609j G17a-project 回归：
 * - PLATFORM-02 存储接近配额时清库恢复点改走 IndexedDB 快照 + 小 marker，不再必然失败；
 * - PLATFORM-05 导出侧与读取侧同口径：已隔离的损坏键按降级视图导出，原文随隔离区带出；
 * - PLATFORM-08 项目导入建立 journal 失败且 IDB journal 未能撤销时必须锁定，不得宣称「未改写」后放行编辑。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb } from '../../platform/adapter';
import { useApp } from '../../store/appStore';
import {
  CLEAR_RECOVERY_STORAGE_KEY,
  persistClearRecoveryIntentBounded,
  readClearRecoveryMarker,
  recoverPendingClearOperation,
} from '../../platform/clearRecovery';
import {
  applyProjectText,
  buildProjectJson,
  buildProjectJsonFull,
  getLastProjectExportDegradedStores,
  recoverPendingProjectImport,
} from '../../platform/project';
import { preserveCorruptStore } from '../../store/quarantine';
import { reloadAnalyses, useAnalyses } from '../../store/analyses';
import { cancelPendingDatasetWork, loadValidatedStoreJson, settlePendingDatasetWrites } from '../../store/dataStore';
import { clearDurableBusinessDataAtomically, OptionsModal } from '../shell/OptionsModal';

// ---------------------------------------------------------------------------
// 仓库同款 IndexedDB 内存夹具（只实现 journal/清库快照用到的事务语义）。
interface MutableRequest {
  result?: unknown;
  error?: DOMException | null;
  onsuccess?: () => void;
  onerror?: () => void;
  onupgradeneeded?: () => void;
  onblocked?: () => void;
}

interface MutableTransaction {
  error: DOMException | null;
  oncomplete?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  abort(): void;
  objectStore(): MutableObjectStore;
}

interface MutableObjectStore {
  get(key: string): MutableRequest;
  add(value: unknown, key: string): MutableRequest;
  put(value: unknown, key: string): MutableRequest;
  delete(key: string): MutableRequest;
}

class MemoryIndexedDb {
  readonly records = new Map<string, unknown>();
  failDeletes = 0;
  failPuts = 0;
  private opened = false;

  open(): IDBOpenDBRequest {
    const request: MutableRequest = {};
    queueMicrotask(() => {
      request.result = this.database();
      if (!this.opened) {
        this.opened = true;
        request.onupgradeneeded?.();
      }
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }

  private database(): IDBDatabase {
    return {
      objectStoreNames: { contains: () => this.opened },
      createObjectStore: () => ({}),
      transaction: () => this.transaction() as unknown as IDBTransaction,
      close: () => undefined,
    } as unknown as IDBDatabase;
  }

  private transaction(): MutableTransaction {
    let pending = 0;
    let aborted = false;
    let completionQueued = false;
    const tx: MutableTransaction = {
      error: null,
      abort: () => {
        if (aborted) return;
        aborted = true;
        tx.onabort?.();
      },
      objectStore: () => store,
    };
    const maybeComplete = () => {
      if (aborted || pending !== 0 || completionQueued) return;
      completionQueued = true;
      queueMicrotask(() => {
        completionQueued = false;
        if (!aborted && pending === 0) tx.oncomplete?.();
      });
    };
    const request = (operation: () => unknown): MutableRequest => {
      const req: MutableRequest = {};
      pending += 1;
      queueMicrotask(() => {
        if (aborted) return;
        try {
          req.result = operation();
          req.onsuccess?.();
        } catch (error) {
          const failure = error instanceof DOMException ? error : new DOMException(String(error), 'UnknownError');
          req.error = failure;
          tx.error = failure;
          req.onerror?.();
          tx.onerror?.();
        } finally {
          pending -= 1;
          maybeComplete();
        }
      });
      return req;
    };
    const store: MutableObjectStore = {
      get: (key) => request(() => this.records.get(key)),
      add: (value, key) => request(() => {
        if (this.records.has(key)) throw new DOMException('record already exists', 'ConstraintError');
        this.records.set(key, value);
        return key;
      }),
      put: (value, key) => request(() => {
        if (this.failPuts-- > 0) throw new DOMException('injected put failure', 'UnknownError');
        this.records.set(key, value);
        return key;
      }),
      delete: (key) => request(() => {
        if (this.failDeletes-- > 0) throw new DOMException('injected delete failure', 'UnknownError');
        this.records.delete(key);
        return undefined;
      }),
    };
    return tx;
  }
}

const nativeIndexedDb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
const nativeSetItem = Storage.prototype.setItem;
const nativeGetItem = Storage.prototype.getItem;
let idb: MemoryIndexedDb;

function installIdb(): void {
  idb = new MemoryIndexedDb();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: idb });
}

function removeIdb(): void {
  if (nativeIndexedDb === undefined) delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  else Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: nativeIndexedDb });
}

/** 按 UTF-16 码元计的 localStorage 配额桩（与浏览器/jsdom 同口径：key+value 长度）。 */
const QUOTA = 400_000;
function installQuota(): void {
  Storage.prototype.setItem = function quotaLimited(this: Storage, key: string, value: string) {
    let used = 0;
    for (let i = 0; i < this.length; i++) {
      const k = this.key(i);
      if (k === null || k === key) continue;
      used += k.length + (nativeGetItem.call(this, k) ?? '').length;
    }
    if (used + key.length + String(value).length > QUOTA) {
      throw new DOMException(`The ${QUOTA}-code unit storage quota has been exceeded.`, 'QuotaExceededError');
    }
    return nativeSetItem.call(this, key, value);
  };
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

/** 业务键合计约占配额 55%：内联 marker（≈2× 峰值）必然写不下。 */
function fillBusinessData(): Record<string, string> {
  const values: Record<string, string> = {
    'qp-dataset-v1': JSON.stringify({ blob: 'd'.repeat(Math.floor(QUOTA * 0.3)) }),
    'qp-recents-v1': JSON.stringify([{ blob: 'r'.repeat(Math.floor(QUOTA * 0.25)) }]),
  };
  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  return values;
}

beforeEach(() => {
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  removeIdb();
});

afterEach(async () => {
  cleanup();
  useApp.getState().setBusyOverlay(null);
  Storage.prototype.setItem = nativeSetItem;
  Storage.prototype.getItem = nativeGetItem;
  platform.datasetDb = null;
  removeIdb();
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('PLATFORM-02 存储接近配额时清库不再必然失败', () => {
  it('Web：业务数据占配额 55% 时清除成功，IndexedDB 快照随后清扫、不滞留', async () => {
    installIdb();
    fillBusinessData();
    installQuota();

    await expect(clearDurableBusinessDataAtomically(null)).resolves.toBeUndefined();
    expect(localStorage.getItem('qp-dataset-v1')).toBeNull();
    expect(localStorage.getItem('qp-recents-v1')).toBeNull();
    expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(idb.records.size).toBe(0);
  });

  it('桌面：SQLite 明确未提交时回写全部浏览器键，快照清扫', async () => {
    installIdb();
    const originals = fillBusinessData();
    installQuota();
    const clear = vi.fn(async () => { throw new Error('sqlite rollback'); });
    const clearStatus = vi.fn(async () => null);

    await expect(clearDurableBusinessDataAtomically(emptyDb({ clear, clearStatus })))
      .rejects.toThrow(/sqlite rollback.*浏览器数据已恢复/s);
    for (const [key, value] of Object.entries(originals)) expect(localStorage.getItem(key)).toBe(value);
    expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(idb.records.size).toBe(0);
  });

  it('外部快照 marker 很小；崩溃后启动按回执为空恢复浏览器快照', async () => {
    installIdb();
    const originals = fillBusinessData();
    installQuota();
    const snapshot = Object.entries(originals) as Array<readonly [string, string]>;

    const marker = await persistClearRecoveryIntentBounded('clear-crash-near-quota', snapshot);
    expect(marker).toMatchObject({ version: 2, snapshotStore: 'indexeddb', entries: 2, phase: 'prepared' });
    expect((localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY) ?? '').length).toBeLessThan(1000);
    expect(readClearRecoveryMarker()).toEqual(marker);
    // 模拟删除完浏览器键后崩溃。
    for (const key of Object.keys(originals)) localStorage.removeItem(key);

    await expect(recoverPendingClearOperation(emptyDb({ clearStatus: vi.fn(async () => null) })))
      .resolves.toEqual({ ready: true, recovered: true, committed: false, error: null });
    for (const [key, value] of Object.entries(originals)) expect(localStorage.getItem(key)).toBe(value);
    expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(idb.records.size).toBe(0);
  });

  it('外部快照：启动时回执确认 committed 则保持删除', async () => {
    installIdb();
    const originals = fillBusinessData();
    installQuota();
    await persistClearRecoveryIntentBounded('clear-commit-near-quota',
      Object.entries(originals) as Array<readonly [string, string]>);
    localStorage.removeItem('qp-dataset-v1');

    await expect(recoverPendingClearOperation(emptyDb({
      clearStatus: vi.fn(async (opId: string) => ({ opId, committed: true as const, removed: 1 })),
    }))).resolves.toMatchObject({ ready: true, recovered: true, committed: true });
    expect(localStorage.getItem('qp-dataset-v1')).toBeNull();
    expect(localStorage.getItem('qp-recents-v1')).toBeNull();
    expect(idb.records.size).toBe(0);
  });

  it('外部快照缺失时启动 fail-closed，保留 marker 不猜测', async () => {
    installIdb();
    const originals = fillBusinessData();
    installQuota();
    await persistClearRecoveryIntentBounded('clear-snapshot-lost',
      Object.entries(originals) as Array<readonly [string, string]>);
    idb.records.clear();

    const result = await recoverPendingClearOperation(emptyDb());
    expect(result).toMatchObject({ ready: false, recovered: false, committed: null });
    expect(result.error).toMatch(/恢复快照缺失/);
    expect(readClearRecoveryMarker()?.opId).toBe('clear-snapshot-lost');
  });

  it('无 IndexedDB 时零修改拒绝，并给出释放空间的可执行出路而非「再重试」', async () => {
    const originals = fillBusinessData();
    installQuota();

    const error = await clearDurableBusinessDataAtomically(null).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ clearOutcome: 'not-committed', recoveryPointUnavailable: true });
    expect(String(error)).toMatch(/尚未删除任何数据/);
    expect(String(error)).toMatch(/最近数据集/);
    for (const [key, value] of Object.entries(originals)) expect(localStorage.getItem(key)).toBe(value);
    expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('UI：恢复点无法建立时提示释放空间，不再引导「再重试」这一必然同样失败的操作', async () => {
    fillBusinessData();
    installQuota();
    const showToast = vi.fn();
    const originalShowToast = useApp.getState().showToast;
    useApp.setState({ showToast });
    try {
      render(<OptionsModal onClose={() => undefined} />);
      fireEvent.click(screen.getByRole('button', { name: '清除数据并恢复演示' }));
      fireEvent.click(screen.getByRole('button', { name: '再次点击确认彻底清除' }));
      await waitFor(() => expect(showToast).toHaveBeenCalled());
      const message = String(showToast.mock.lastCall?.[0]);
      expect(message).toMatch(/本地数据清除未提交/);
      expect(message).toMatch(/最近数据集/);
      expect(message).not.toMatch(/再重试/);
      expect(useApp.getState().busyOverlay).toBeNull();
    } finally {
      useApp.setState({ showToast: originalShowToast });
    }
  });

  it('UI：有 IndexedDB 时近满存储下两次确认即清除成功', async () => {
    installIdb();
    fillBusinessData();
    installQuota();
    const showToast = vi.fn();
    const originalShowToast = useApp.getState().showToast;
    useApp.setState({ showToast });
    try {
      render(<OptionsModal onClose={() => undefined} />);
      fireEvent.click(screen.getByRole('button', { name: '清除数据并恢复演示' }));
      fireEvent.click(screen.getByRole('button', { name: '再次点击确认彻底清除' }));
      await waitFor(() => expect(showToast).toHaveBeenCalled());
      expect(String(showToast.mock.lastCall?.[0])).toMatch(/已清除/);
      expect(idb.records.size).toBe(0);
      expect(localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY)).toBeNull();
    } finally {
      useApp.setState({ showToast: originalShowToast });
    }
  });
});

// ---------------------------------------------------------------------------
describe('PLATFORM-05 导出侧与读取侧同口径', () => {
  it('qp-analyses-v1 损坏且已被读取侧隔离：完整导出成功，原文随隔离区带出', async () => {
    const corrupt = '[{"id":"broken"}]';
    const specs = JSON.stringify({ 直径: { lsl: 1, tgt: 2, usl: 3 } });
    localStorage.setItem('qp-analyses-v1', corrupt);
    localStorage.setItem('qp-specs-v1', specs);
    reloadAnalyses(); // 真实读取侧：隔离原文、内存降级为空
    expect(useAnalyses.getState().saved).toEqual([]);
    expect(localStorage.getItem('qp-analyses-v1')).toBe(corrupt);

    const encoded = await buildProjectJsonFull('test');
    const file = JSON.parse(encoded) as { stores: Record<string, string> };
    expect(file.stores['qp-analyses-v1']).toBeUndefined();
    expect(file.stores['qp-specs-v1']).toBe(specs);
    const quarantine = JSON.parse(file.stores['qp-quarantine-v1']) as Record<string, { raw: string }>;
    expect(quarantine['qp-analyses-v1'].raw).toBe(corrupt);
    expect(getLastProjectExportDegradedStores()).toEqual(['qp-analyses-v1']);
    // live 键原样保留（取证保底不被导出改写）。
    expect(localStorage.getItem('qp-analyses-v1')).toBe(corrupt);
  });

  it.each([
    ['qp-pareto-v1', '"不是对象"'],
    ['qp-copy-sequences-v1', '[]'],
    ['qp-specs-v1', '{"x":{"lsl":"a"}}'],
  ])('%s 损坏且经 loadValidatedStoreJson 隔离后导出不再被整份拒绝', (key, corrupt) => {
    localStorage.setItem(key, corrupt);
    expect(loadValidatedStoreJson(key)).toBeNull();

    const file = JSON.parse(buildProjectJson('test', true)) as { stores: Record<string, string> };
    expect(file.stores[key]).toBeUndefined();
    expect((JSON.parse(file.stores['qp-quarantine-v1']) as Record<string, { raw: string }>)[key].raw).toBe(corrupt);
  });

  it('二次损坏（latestRaw）同样按降级视图导出', () => {
    localStorage.setItem('qp-pareto-v1', '1');
    expect(loadValidatedStoreJson('qp-pareto-v1')).toBeNull();
    localStorage.setItem('qp-pareto-v1', '2');
    expect(loadValidatedStoreJson('qp-pareto-v1')).toBeNull();
    const file = JSON.parse(buildProjectJson('test', true)) as { stores: Record<string, string> };
    expect(file.stores['qp-pareto-v1']).toBeUndefined();
  });

  it('损坏原文未进隔离区时仍 fail-closed（降级会销毁唯一证据）', () => {
    localStorage.setItem('qp-analyses-v1', '[{"id":"broken"}]');
    expect(() => buildProjectJson('test', true)).toThrow(/qp-analyses-v1」损坏，项目未导出/);
    // 隔离区里是另一份原文时也不放行。
    preserveCorruptStore('qp-analyses-v1', '[{"id":"other"}]', '旧损坏');
    expect(() => buildProjectJson('test', true)).toThrow(/qp-analyses-v1」损坏，项目未导出/);
  });

  it('AQL 责任账本损坏保持显式 fail-closed，不因已隔离而放行', () => {
    const corrupt = '{"records":"坏"}';
    localStorage.setItem('qp-aql-state-v1', corrupt);
    expect(preserveCorruptStore('qp-aql-state-v1', corrupt, '账本结构无效')).toBe(true);
    expect(() => buildProjectJson('test', true)).toThrow(/qp-aql-state-v1/);
  });
});

// ---------------------------------------------------------------------------
function projectWithSpecs(label: string, vault?: Record<string, string>) {
  return JSON.stringify({
    format: 'quality-platform-project',
    formatVersion: 4,
    appVersion: 'test',
    exportedAt: '2026-09-26T00:00:00.000Z',
    stores: { 'qp-specs-v1': JSON.stringify({ [label]: { lsl: 1, tgt: 2, usl: 3 } }) },
    ...(vault ? { vault } : {}),
  });
}

function failJournalMarker(): void {
  Storage.prototype.setItem = function markerQuota(this: Storage, key: string, value: string) {
    if (key.includes('project-import-journal')) throw new DOMException('quota', 'QuotaExceededError');
    return nativeSetItem.call(this, key, value);
  };
}

describe('PLATFORM-08 journal 建立失败不得在重启后复活并覆盖失败后的编辑', () => {
  it('stores-only：marker 写失败且 IDB 清理失败 → lockRequired=true，要求立即重启', async () => {
    installIdb();
    localStorage.setItem('qp-specs-v1', JSON.stringify({ BEFORE: { lsl: 0, tgt: 1, usl: 2 } }));
    failJournalMarker();
    idb.failDeletes = 1;

    const result = await applyProjectText(projectWithSpecs('ABORTED-IMPORT'));
    expect(result.lockRequired).toBe(true);
    expect(result.error).toMatch(/未能撤销.*重新启动/s);
    expect(result.error).not.toMatch(/项目未改写/);
    // 裁决规则不变：残留的完整 journal 仍是启动恢复事实。
    expect(idb.records.get('active')).toMatchObject({ version: 2, phase: 'stores-only' });
  });

  it('stores-only：marker 写失败但 IDB 清理读回确认 → 可安全解锁，重启不复活，失败后的编辑保留', async () => {
    installIdb();
    localStorage.setItem('qp-specs-v1', JSON.stringify({ BEFORE: { lsl: 0, tgt: 1, usl: 2 } }));
    failJournalMarker();

    const result = await applyProjectText(projectWithSpecs('ABORTED-IMPORT'));
    expect(result).toMatchObject({ lockRequired: false });
    expect(result.error).toMatch(/项目未改写/);
    expect(idb.records.has('active')).toBe(false);

    Storage.prototype.setItem = nativeSetItem;
    const userWork = JSON.stringify({ USER_WORK_AFTER_FAILURE: { lsl: 5, tgt: 6, usl: 7 } });
    localStorage.setItem('qp-specs-v1', userWork);
    await expect(recoverPendingProjectImport()).resolves.toMatchObject({ recovered: false, error: null });
    expect(localStorage.getItem('qp-specs-v1')).toBe(userWork);
  });

  it('before-vault（桌面原子导入）：同样在 journal 未撤销时锁定', async () => {
    installIdb();
    platform.datasetDb = emptyDb({
      beginProjectImport: vi.fn(async () => undefined),
      commitProjectImport: vi.fn(async () => undefined),
      rollbackProjectImport: vi.fn(async () => undefined),
      pendingProjectImport: vi.fn(async () => null),
    });
    localStorage.setItem('qp-specs-v1', JSON.stringify({ old: { lsl: 0, tgt: 1, usl: 2 } }));
    failJournalMarker();
    idb.failDeletes = 1;

    const result = await applyProjectText(projectWithSpecs('IMPORTED', {}));
    expect(result.lockRequired).toBe(true);
    expect(result.error).toMatch(/未能撤销/);
    expect(platform.datasetDb.beginProjectImport).not.toHaveBeenCalled();
  });
});
