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

export type BrowserDataSnapshot = Array<readonly [key: string, value: string]>;
export type ClearRecoveryPhase = 'prepared' | 'browser-cleared';

export interface ClearRecoveryMarker {
  format: typeof CLEAR_RECOVERY_FORMAT;
  version: typeof CLEAR_RECOVERY_VERSION;
  opId: string;
  phase: ClearRecoveryPhase;
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
    || parsed.version !== CLEAR_RECOVERY_VERSION
    || (parsed.phase !== 'prepared' && parsed.phase !== 'browser-cleared')
  ) {
    throw new Error('清库恢复记录的格式或版本无效');
  }
  assertOperationId(parsed.opId);
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
  assertSnapshot(marker.snapshot);
  const raw = JSON.stringify(marker);
  if (encodedBytes(raw) > MAX_CLEAR_RECOVERY_BYTES) {
    throw new Error('待清除的浏览器数据过大，无法建立有界恢复记录；清库已安全中止');
  }
  return raw;
}

export function readClearRecoveryMarker(): ClearRecoveryMarker | null {
  const raw = localStorage.getItem(CLEAR_RECOVERY_STORAGE_KEY);
  return raw === null ? null : parseMarker(raw);
}

/** 在删除任一业务键前持久化并读回确认恢复意图。已有意图绝不覆盖。 */
export function persistClearRecoveryIntent(
  opId: string,
  snapshot: BrowserDataSnapshot,
): ClearRecoveryMarker {
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
  const marker: ClearRecoveryMarker = {
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
    return { ready: true, recovered: false, committed: null, error: null };
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
    if (committed) deleteBrowserSnapshot(marker.snapshot);
    else {
      const failed = restoreBrowserSnapshot(marker.snapshot);
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
  return { ready: true, recovered: true, committed, error: null };
}
