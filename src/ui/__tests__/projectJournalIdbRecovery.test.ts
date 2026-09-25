/**
 * IndexedDB 项目导入 journal 的崩溃窗口：固定 record 是真实恢复事实，
 * localStorage marker 只是兼容性索引，绝不得成为启动发现的唯一条件。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '../../platform/adapter';
import {
  applyProjectText,
  recoverPendingProjectImport,
  settleProjectImportRecoveryBeforeDataClear,
} from '../../platform/project';

const JOURNAL_RECORD = 'active';

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

/** 只实现 project journal 用到的 IDB 事务语义，特别保留 add 的唯一性。 */
class MemoryIndexedDb {
  readonly records = new Map<string, unknown>();
  failGets = 0;
  failPuts = 0;
  failDeletes = 0;
  private opened = false;

  open(): IDBOpenDBRequest {
    const request: MutableRequest = {};
    queueMicrotask(() => {
      const db = this.database();
      request.result = db;
      if (!this.opened) {
        this.opened = true;
        request.onupgradeneeded?.();
      }
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }

  private database(): IDBDatabase {
    const objectStoreNames = { contains: () => this.opened };
    return {
      objectStoreNames,
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
          const failure = error instanceof DOMException
            ? error
            : new DOMException(String(error), 'UnknownError');
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
      get: (key) => request(() => {
        if (this.failGets-- > 0) throw new DOMException('injected get failure', 'UnknownError');
        return this.records.get(key);
      }),
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

const nativeIndexedDb = globalThis.indexedDB;
const nativeSetItem = Storage.prototype.setItem;
let idb: MemoryIndexedDb;

function projectWithSpecs(label: string) {
  return JSON.stringify({
    format: 'quality-platform-project',
    formatVersion: 4,
    appVersion: 'test',
    exportedAt: '2026-08-13T00:00:00.000Z',
    stores: {
      'qp-specs-v1': JSON.stringify({ [label]: { lsl: 1, tgt: 2, usl: 3 } }),
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  platform.datasetDb = null;
  idb = new MemoryIndexedDb();
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: idb,
  });
});

afterEach(() => {
  Storage.prototype.setItem = nativeSetItem;
  platform.datasetDb = null;
  if (nativeIndexedDb === undefined) delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  else Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: nativeIndexedDb,
  });
  vi.restoreAllMocks();
});

describe('IndexedDB journal 无 marker 启动裁决', () => {
  it('完整 record 已写、marker 未写时崩溃，启动仍前向完成并清理孤儿', async () => {
    const oldSpecs = JSON.stringify({ old: { lsl: 0, tgt: 1, usl: 2 } });
    localStorage.setItem('qp-specs-v1', oldSpecs);
    idb.failDeletes = 1; // marker 写失败后的就地清理也注入中断。
    Storage.prototype.setItem = function failJournalMarker(key: string, value: string) {
      if (key.includes('project-import-journal')) throw new Error('injected crash before marker');
      return nativeSetItem.call(this, key, value);
    };

    const interrupted = await applyProjectText(projectWithSpecs('new'));
    expect(interrupted.error).toContain('injected crash before marker');
    expect(localStorage.getItem('qp-specs-v1')).toBe(oldSpecs);
    expect(idb.records.get(JOURNAL_RECORD)).toMatchObject({ version: 2, phase: 'stores-only' });
    expect([...Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))]
      .some((key) => key?.includes('project-import-journal'))).toBe(false);

    Storage.prototype.setItem = nativeSetItem;
    await expect(recoverPendingProjectImport()).resolves.toEqual({
      recovered: true, error: null, reloadRequired: true,
    });
    expect(JSON.parse(localStorage.getItem('qp-specs-v1')!)).toHaveProperty('new');
    expect(idb.records.has(JOURNAL_RECORD)).toBe(false);
  });

  it('完整 IDB record 可裁决损坏的非权威 marker，不留永久孤儿', async () => {
    idb.failDeletes = 1;
    Storage.prototype.setItem = function corruptJournalMarker(key: string, value: string) {
      if (key.includes('project-import-journal')) {
        nativeSetItem.call(this, key, '{truncated-marker');
        throw new Error('injected crash with corrupt marker');
      }
      return nativeSetItem.call(this, key, value);
    };

    const interrupted = await applyProjectText(projectWithSpecs('recovered'));
    expect(interrupted.error).toContain('corrupt marker');
    expect(idb.records.get(JOURNAL_RECORD)).toMatchObject({ version: 2, phase: 'stores-only' });

    Storage.prototype.setItem = nativeSetItem;
    await expect(recoverPendingProjectImport()).resolves.toEqual({
      recovered: true, error: null, reloadRequired: true,
    });
    expect(JSON.parse(localStorage.getItem('qp-specs-v1')!)).toHaveProperty('recovered');
    expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .some((key) => key?.includes('project-import-journal'))).toBe(false);
    expect(idb.records.has(JOURNAL_RECORD)).toBe(false);
  });

  it('reserved 占位表示 stores 尚未改写，启动/清库前可安全删除', async () => {
    const oldSpecs = JSON.stringify({ keep: { lsl: 0, tgt: 1, usl: 2 } });
    localStorage.setItem('qp-specs-v1', oldSpecs);
    idb.records.set(JOURNAL_RECORD, { version: 2, state: 'reserved', token: 'crash-after-add' });

    await expect(settleProjectImportRecoveryBeforeDataClear()).resolves.toBeUndefined();
    expect(localStorage.getItem('qp-specs-v1')).toBe(oldSpecs);
    expect(idb.records.has(JOURNAL_RECORD)).toBe(false);
  });

  it('reserved 占位删除失败时保留记录并阻断，不假装已清理', async () => {
    idb.records.set(JOURNAL_RECORD, { version: 2, state: 'reserved', token: 'delete-fails' });
    idb.failDeletes = 1;

    const recovery = await recoverPendingProjectImport();
    expect(recovery).toMatchObject({ recovered: false, reloadRequired: false });
    expect(recovery.error).toMatch(/IndexedDB journal 写入失败|injected delete failure/);
    expect(idb.records.has(JOURNAL_RECORD)).toBe(true);
  });

  it('无 marker 的损坏 record 原样保留并 fail-closed', async () => {
    const corrupt = { version: 2, target: 'truncated' };
    idb.records.set(JOURNAL_RECORD, corrupt);

    const recovery = await recoverPendingProjectImport();
    expect(recovery).toMatchObject({ recovered: false, reloadRequired: false });
    expect(recovery.error).toContain('journal 结构无效');
    expect(idb.records.get(JOURNAL_RECORD)).toBe(corrupt);
  });

  it('IDB 读取失败时不猜测“无 journal”，保持启动阻断', async () => {
    idb.records.set(JOURNAL_RECORD, { version: 2, state: 'reserved', token: 'unreadable' });
    idb.failGets = 1;

    const recovery = await recoverPendingProjectImport();
    expect(recovery).toMatchObject({ recovered: false, reloadRequired: false });
    expect(recovery.error).toMatch(/IndexedDB journal 读取失败|injected get failure/);
    expect(idb.records.has(JOURNAL_RECORD)).toBe(true);
  });

  it('并发导入通过 IDB add 唯一约束只允许一个写者进入', async () => {
    const [left, right] = await Promise.all([
      applyProjectText(projectWithSpecs('left')),
      applyProjectText(projectWithSpecs('right')),
    ]);
    const results = [left, right];
    expect(results.filter((result) => result.error === null)).toHaveLength(1);
    expect(results.filter((result) => result.error !== null)).toHaveLength(1);
    expect(results.find((result) => result.error)?.error).toMatch(/journal|record already exists/);
    const stored = JSON.parse(localStorage.getItem('qp-specs-v1') ?? '{}');
    expect(Object.keys(stored)).toHaveLength(1);
    expect(['left', 'right']).toContain(Object.keys(stored)[0]);
    expect(idb.records.has(JOURNAL_RECORD)).toBe(false);
  });
});
