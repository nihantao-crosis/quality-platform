import { errText, platform, type DatasetClearReceipt, type DatasetDb } from './adapter';

export const CLEAR_RECOVERY_STORAGE_KEY = 'qp-clear-recovery-v1';

const CLEAR_RECOVERY_FORMAT = 'quality-platform-clear-recovery';
const CLEAR_RECOVERY_VERSION = 1;
const MAX_CLEAR_RECOVERY_ENTRIES = 64;
const MAX_CLEAR_RECOVERY_KEY_CHARS = 512;
/**
 * 恢复记录会与原 browser 数据短暂并存。固定上限既避免损坏 marker 令启动
 * 无界分配，也让存储接近配额时安全拒绝清库，而不是冒险进入不可恢复窗口。
 */
export const MAX_CLEAR_RECOVERY_BYTES = 8 * 1024 * 1024;

/**
 * 存储接近配额时，内联 marker（与原数据并存，峰值≈2×）必然写不下，而此时正是用户最需要
 * 清库腾空间的时候（fix2609j PLATFORM-02）。回退：把完整快照写进 IndexedDB（配额独立于
 * localStorage），localStorage 只留一个引用 + 条目数/码元数校验的小 marker。
 */
const CLEAR_RECOVERY_EXTERNAL_VERSION = 2;
const CLEAR_RECOVERY_IDB_NAME = 'quality-platform-clear-recovery';
const CLEAR_RECOVERY_IDB_STORE = 'snapshots';
const CLEAR_RECOVERY_IDB_RECORD = 'clear-snapshot';

/** 恢复点无法建立时给用户的可执行出路：这些操作写入更小的值，在近满状态下通常仍能成功。 */
export const CLEAR_RECOVERY_SPACE_HINT = '请先在左侧「最近数据集」逐条移除不需要的条目，或删除已保存分析以释放浏览器存储空间，再清除数据';

export type BrowserDataSnapshot = Array<readonly [key: string, value: string]>;
export type ClearRecoveryPhase = 'prepared' | 'browser-cleared';

export interface InlineClearRecoveryMarker {
  format: typeof CLEAR_RECOVERY_FORMAT;
  version: typeof CLEAR_RECOVERY_VERSION;
  opId: string;
  phase: ClearRecoveryPhase;
  snapshot: BrowserDataSnapshot;
}

/** 快照在 IndexedDB；marker 只保留引用与一致性校验量。 */
export interface ExternalClearRecoveryMarker {
  format: typeof CLEAR_RECOVERY_FORMAT;
  version: typeof CLEAR_RECOVERY_EXTERNAL_VERSION;
  opId: string;
  phase: ClearRecoveryPhase;
  snapshotStore: 'indexeddb';
  entries: number;
  chars: number;
}

export type ClearRecoveryMarker = InlineClearRecoveryMarker | ExternalClearRecoveryMarker;

interface ExternalSnapshotRecord {
  format: typeof CLEAR_RECOVERY_FORMAT;
  opId: string;
  snapshot: BrowserDataSnapshot;
}

export interface ClearRecoveryResult {
  ready: boolean;
  recovered: boolean;
  committed: boolean | null;
  error: string | null;
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOperationId(opId: unknown): asserts opId is string {
  if (
    typeof opId !== 'string'
    || opId.length < 1
    || opId.length > 128
    || !/^[\x21-\x7e]+$/.test(opId)
  ) {
    throw new Error('清库恢复记录的操作 ID 无效');
  }
}

function assertSnapshot(snapshot: unknown): asserts snapshot is BrowserDataSnapshot {
  if (!Array.isArray(snapshot) || snapshot.length > MAX_CLEAR_RECOVERY_ENTRIES) {
    throw new Error(`清库恢复记录最多允许 ${MAX_CLEAR_RECOVERY_ENTRIES} 个浏览器键`);
  }
  const seen = new Set<string>();
  for (const entry of snapshot) {
    if (
      !Array.isArray(entry)
      || entry.length !== 2
      || typeof entry[0] !== 'string'
      || entry[0].length < 1
      || entry[0].length > MAX_CLEAR_RECOVERY_KEY_CHARS
      || typeof entry[1] !== 'string'
      || entry[0] === CLEAR_RECOVERY_STORAGE_KEY
      || seen.has(entry[0])
    ) {
      throw new Error('清库恢复记录包含无效或重复的浏览器键');
    }
    seen.add(entry[0]);
  }
}

function parseMarker(raw: string): ClearRecoveryMarker {
  if (encodedBytes(raw) > MAX_CLEAR_RECOVERY_BYTES) {
    throw new Error('清库恢复记录超过安全大小上限');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('清库恢复记录不是有效 JSON');
  }
  if (
    !isRecord(parsed)
    || parsed.format !== CLEAR_RECOVERY_FORMAT
    || (parsed.version !== CLEAR_RECOVERY_VERSION && parsed.version !== CLEAR_RECOVERY_EXTERNAL_VERSION)
    || (parsed.phase !== 'prepared' && parsed.phase !== 'browser-cleared')
  ) {
    throw new Error('清库恢复记录的格式或版本无效');
  }
  assertOperationId(parsed.opId);
  if (parsed.version === CLEAR_RECOVERY_EXTERNAL_VERSION) {
    if (
      parsed.snapshotStore !== 'indexeddb'
      || !Number.isSafeInteger(parsed.entries)
      || (parsed.entries as number) < 0
      || (parsed.entries as number) > MAX_CLEAR_RECOVERY_ENTRIES
      || !Number.isSafeInteger(parsed.chars)
      || (parsed.chars as number) < 0
    ) {
      throw new Error('清库恢复记录的外部快照引用无效');
    }
    return {
      format: CLEAR_RECOVERY_FORMAT,
      version: CLEAR_RECOVERY_EXTERNAL_VERSION,
      opId: parsed.opId,
      phase: parsed.phase,
      snapshotStore: 'indexeddb',
      entries: parsed.entries as number,
      chars: parsed.chars as number,
    };
  }
  assertSnapshot(parsed.snapshot);
  return {
    format: CLEAR_RECOVERY_FORMAT,
    version: CLEAR_RECOVERY_VERSION,
    opId: parsed.opId,
    phase: parsed.phase,
    snapshot: parsed.snapshot,
  };
}

function serializeMarker(marker: ClearRecoveryMarker): string {
  assertOperationId(marker.opId);
  if (marker.version === CLEAR_RECOVERY_VERSION) assertSnapshot(marker.snapshot);
  const raw = JSON.stringify(marker);
  if (encodedBytes(raw) > MAX_CLEAR_RECOVERY_BYTES) {
    throw new Error('待清除的浏览器数据过大，无法建立有界恢复记录；清库已安全中止');
  }
  return raw;
}

function snapshotChars(snapshot: BrowserDataSnapshot): number {
  return snapshot.reduce((sum, [key, value]) => sum + key.length + value.length, 0);
}

function supportsClearRecoveryIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function';
}

function openClearRecoveryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CLEAR_RECOVERY_IDB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CLEAR_RECOVERY_IDB_STORE)) {
        request.result.createObjectStore(CLEAR_RECOVERY_IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
    request.onblocked = () => reject(new Error('IndexedDB 被其他窗口阻塞'));
  });
}

async function clearRecoveryIdbRequest(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  const db = await openClearRecoveryDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CLEAR_RECOVERY_IDB_STORE, mode);
      const request = operation(tx.objectStore(CLEAR_RECOVERY_IDB_STORE));
      let result: unknown = null;
      request.onsuccess = () => { result = request.result ?? null; };
      request.onerror = () => reject(request.error ?? tx.error ?? new Error('IndexedDB 清库快照请求失败'));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 清库快照事务失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 清库快照事务中止'));
    });
  } finally {
    db.close();
  }
}

async function readExternalSnapshot(marker: ExternalClearRecoveryMarker): Promise<BrowserDataSnapshot> {
  if (!supportsClearRecoveryIndexedDb()) {
    throw new Error('清库恢复快照位于 IndexedDB，但当前环境无法读取');
  }
  const record = await clearRecoveryIdbRequest('readonly', (store) => store.get(CLEAR_RECOVERY_IDB_RECORD));
  if (!isRecord(record) || record.format !== CLEAR_RECOVERY_FORMAT || record.opId !== marker.opId) {
    throw new Error(`清库恢复快照缺失或与操作 ${marker.opId} 不匹配`);
  }
  assertSnapshot(record.snapshot);
  if (record.snapshot.length !== marker.entries || snapshotChars(record.snapshot) !== marker.chars) {
    throw new Error('清库恢复快照与恢复记录的条目数/体积校验不一致');
  }
  return record.snapshot;
}

async function writeExternalSnapshot(opId: string, snapshot: BrowserDataSnapshot): Promise<void> {
  const record: ExternalSnapshotRecord = { format: CLEAR_RECOVERY_FORMAT, opId, snapshot };
  await clearRecoveryIdbRequest('readwrite', (store) => store.put(record, CLEAR_RECOVERY_IDB_RECORD));
}

async function deleteExternalSnapshot(): Promise<void> {
  await clearRecoveryIdbRequest('readwrite', (store) => store.delete(CLEAR_RECOVERY_IDB_RECORD));
}

/**
 * 删除已无 marker 引用的 IndexedDB 清库快照（尽力而为）。只在 localStorage 确认没有
 * marker 时动手；marker 仍在（状态未决）时快照是恢复依据，绝不删除。
 * 快照里是用户要求清除的业务数据，不能在清库完成后长期滞留。
 */
export async function sweepOrphanClearRecoverySnapshot(): Promise<void> {
  if (!supportsClearRecoveryIndexedDb()) return;
  try {
    if (localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY) !== null) return;
  } catch {
    return;
  }
  try { await deleteExternalSnapshot(); } catch { /* 下次启动/清库再尝试 */ }
}

/** 取得 marker 对应的完整快照：内联直接返回，外部从 IndexedDB 读取并校验。 */
export async function loadClearRecoverySnapshot(marker: ClearRecoveryMarker): Promise<BrowserDataSnapshot> {
  return marker.version === CLEAR_RECOVERY_VERSION ? marker.snapshot : readExternalSnapshot(marker);
}

export function readClearRecoveryMarker(): ClearRecoveryMarker | null {
  const raw = localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY);
  return raw === null ? null : parseMarker(raw);
}

/** 在删除任一业务键前持久化并读回确认恢复意图。已有意图绝不覆盖。 */
export function persistClearRecoveryIntent(
  opId: string,
  snapshot: BrowserDataSnapshot,
): InlineClearRecoveryMarker {
  let existing: string | null;
  try {
    existing = localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY);
  } catch (error) {
    throw Object.assign(
      new Error(`无法确认是否存在未决清库恢复记录：${errText(error)}；必须重新启动完成裁决`),
      { cause: error, clearOutcome: 'recovery-pending' },
    );
  }
  if (existing !== null) {
    // 先验证，以便损坏 marker 也明确 fail closed，而不是被新操作覆盖。
    try { parseMarker(existing); } catch { /* 损坏也必须保留原字节并阻断 */ }
    throw Object.assign(
      new Error('检测到尚未裁决的清库恢复记录，请先重新启动完成恢复'),
      { clearOutcome: 'recovery-pending' },
    );
  }
  const marker: InlineClearRecoveryMarker = {
    format: CLEAR_RECOVERY_FORMAT,
    version: CLEAR_RECOVERY_VERSION,
    opId,
    phase: 'prepared',
    snapshot,
  };
  const raw = serializeMarker(marker);
  try {
    localStorage.setItem(CLEAR_RECOVERY_STORAGE_KEY, raw);
    if (localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY) !== raw) {
      throw new Error('恢复记录写入后无法读回');
    }
  } catch (error) {
    let cleanupConfirmed = false;
    try {
      localStorage.removeItem(CLEAR_RECOVERY_STORAGE_KEY);
      cleanupConfirmed = localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY) === null;
    } catch { /* 无法确认 marker 不存在时必须由调用层全局阻断 */ }
    throw Object.assign(
      new Error(cleanupConfirmed
        ? `无法在清库前建立恢复记录：${errText(error)}；尚未删除任何数据`
        : `无法确认清库恢复记录是否已移除：${errText(error)}；必须重新启动完成裁决`),
      { cause: error, clearOutcome: cleanupConfirmed ? 'not-committed' : 'recovery-pending' },
    );
  }
  return marker;
}

function writeMarkerWithReadback(raw: string): void {
  localStorage.setItem(CLEAR_RECOVERY_STORAGE_KEY, raw);
  if (localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY) !== raw) {
    throw new Error('恢复记录写入后无法读回');
  }
}

function clearOutcomeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { clearOutcome?: unknown }).clearOutcome
    : undefined;
}

function recoveryPointUnavailable(message: string, cause: unknown): Error {
  return Object.assign(new Error(`${message}；尚未删除任何数据。${CLEAR_RECOVERY_SPACE_HINT}`), {
    cause,
    clearOutcome: 'not-committed',
    recoveryPointUnavailable: true,
  });
}

/**
 * 清库入口使用的恢复意图持久化：优先沿用内联 marker；写不下（配额/体积上限）且已确认
 * 没有残留 marker 时，改把快照放进 IndexedDB、localStorage 只写小 marker，使峰值占用
 * 不再是业务数据的两倍。仍失败时返回带可执行出路的 not-committed，绝不删除任何数据。
 */
export async function persistClearRecoveryIntentBounded(
  opId: string,
  snapshot: BrowserDataSnapshot,
): Promise<ClearRecoveryMarker> {
  try {
    return persistClearRecoveryIntent(opId, snapshot);
  } catch (inlineError) {
    // 已有未决 marker 或无法确认 marker 是否残留：保持原裁决，不得另建恢复点。
    if (clearOutcomeOf(inlineError) === 'recovery-pending') throw inlineError;
    if (!supportsClearRecoveryIndexedDb()) {
      throw recoveryPointUnavailable(
        `无法在清库前建立恢复记录：${errText(inlineError)}；当前环境无法把恢复快照转存到 IndexedDB`,
        inlineError,
      );
    }
    const marker: ExternalClearRecoveryMarker = {
      format: CLEAR_RECOVERY_FORMAT,
      version: CLEAR_RECOVERY_EXTERNAL_VERSION,
      opId,
      phase: 'prepared',
      snapshotStore: 'indexeddb',
      entries: snapshot.length,
      chars: snapshotChars(snapshot),
    };
    try {
      await writeExternalSnapshot(opId, snapshot);
      // 读回确认 IDB 快照完整，才让小 marker 成为删除前的恢复依据。
      await readExternalSnapshot(marker);
    } catch (idbError) {
      try { await deleteExternalSnapshot(); } catch { /* 无 marker 引用，下次清扫 */ }
      throw recoveryPointUnavailable(
        `无法在清库前建立恢复记录：${errText(inlineError)}；转存 IndexedDB 也失败：${errText(idbError)}`,
        idbError,
      );
    }
    const raw = serializeMarker(marker);
    try {
      writeMarkerWithReadback(raw);
    } catch (markerError) {
      let cleanupConfirmed = false;
      try {
        localStorage.removeItem(CLEAR_RECOVERY_STORAGE_KEY);
        cleanupConfirmed = localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY) === null;
      } catch { /* 无法确认 marker 不存在时必须由调用层全局阻断 */ }
      if (!cleanupConfirmed) {
        throw Object.assign(
          new Error(`无法确认清库恢复记录是否已移除：${errText(markerError)}；必须重新启动完成裁决`),
          { cause: markerError, clearOutcome: 'recovery-pending' },
        );
      }
      try { await deleteExternalSnapshot(); } catch { /* 无 marker 引用，下次清扫 */ }
      throw recoveryPointUnavailable(`无法在清库前写入恢复记录引用：${errText(markerError)}`, markerError);
    }
    return marker;
  }
}

export function updateClearRecoveryPhase(opId: string, phase: ClearRecoveryPhase): void {
  const marker = readClearRecoveryMarker();
  if (!marker || marker.opId !== opId) throw new Error('清库恢复记录与当前操作不匹配');
  const raw = serializeMarker({ ...marker, phase });
  localStorage.setItem(CLEAR_RECOVERY_STORAGE_KEY, raw);
  if (localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY) !== raw) {
    throw new Error('清库恢复阶段写入后无法读回');
  }
}

export function discardClearRecoveryMarker(opId: string): void {
  const marker = readClearRecoveryMarker();
  if (!marker) return;
  if (marker.opId !== opId) throw new Error('拒绝删除另一项清库操作的恢复记录');
  localStorage.removeItem(CLEAR_RECOVERY_STORAGE_KEY);
  if (localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY) !== null) {
    throw new Error('清库恢复记录未能删除');
  }
}

export function restoreBrowserSnapshot(snapshot: BrowserDataSnapshot): string[] {
  const failed: string[] = [];
  for (const [key, value] of snapshot) {
    try {
      localStorage.setItem(key, value);
      if (localStorage.getItem(key) !== value) failed.push(key);
    } catch {
      failed.push(key);
    }
  }
  return failed;
}

export function deleteBrowserSnapshot(snapshot: BrowserDataSnapshot): void {
  for (const [key] of snapshot) {
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw new Error(`键「${key}」未能删除`);
  }
}

export function isCommittedClearReceipt(
  receipt: DatasetClearReceipt | null | undefined,
  opId: string,
): receipt is DatasetClearReceipt {
  return receipt?.committed === true
    && receipt.opId === opId
    && Number.isSafeInteger(receipt.removed)
    && receipt.removed >= 0;
}

/**
 * 无 store 副作用的启动前恢复。项目导入 journal 应先于本函数收口。
 * 状态不可查询或 marker 损坏时保留 marker 并阻断启动，绝不猜测事务结果。
 */
export async function recoverPendingClearOperation(
  db: DatasetDb | null = platform.datasetDb,
): Promise<ClearRecoveryResult> {
  let marker: ClearRecoveryMarker | null;
  try {
    marker = readClearRecoveryMarker();
  } catch (error) {
    return {
      ready: false,
      recovered: false,
      committed: null,
      error: `${errText(error)}；为保护原数据，应用已阻止加载，请保留本机数据并重试`,
    };
  }
  if (!marker) {
    await sweepOrphanClearRecoverySnapshot();
    return { ready: true, recovered: false, committed: null, error: null };
  }
  let snapshot: BrowserDataSnapshot;
  try {
    snapshot = await loadClearRecoverySnapshot(marker);
  } catch (error) {
    return {
      ready: false,
      recovered: false,
      committed: null,
      error: `${errText(error)}；为保护原数据，应用已阻止加载，恢复记录已保留`,
    };
  }

  let committed = false;
  if (db) {
    let receipt: DatasetClearReceipt | null;
    try {
      receipt = await db.clearStatus(marker.opId);
    } catch (error) {
      return {
        ready: false,
        recovered: false,
        committed: null,
        error: `无法查询清库事务 ${marker.opId} 的持久回执：${errText(error)}；恢复记录已保留`,
      };
    }
    if (receipt !== null && !isCommittedClearReceipt(receipt, marker.opId)) {
      return {
        ready: false,
        recovered: false,
        committed: null,
        error: `清库事务 ${marker.opId} 的持久回执不匹配；恢复记录已保留`,
      };
    }
    committed = isCommittedClearReceipt(receipt, marker.opId);
  }

  try {
    if (committed) deleteBrowserSnapshot(snapshot);
    else {
      const failed = restoreBrowserSnapshot(snapshot);
      if (failed.length > 0) throw new Error(`浏览器备份恢复失败：${failed.join('、')}`);
    }
    discardClearRecoveryMarker(marker.opId);
  } catch (error) {
    return {
      ready: false,
      recovered: false,
      committed,
      error: `清库事务 ${marker.opId} 的启动恢复未完成：${errText(error)}；恢复记录已保留`,
    };
  }
  if (marker.version === CLEAR_RECOVERY_EXTERNAL_VERSION) await sweepOrphanClearRecoverySnapshot();
  return { ready: true, recovered: true, committed, error: null };
}
