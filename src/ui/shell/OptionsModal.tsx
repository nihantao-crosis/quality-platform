/** 选项 / 本地数据 — 存储占用一览、清除数据、重置偏好。 */
import { useMemo, useState } from 'react';
import { QUARANTINE_STORAGE_KEY } from '../../store/quarantine';
import {
  AQL_STATE_STORAGE_KEY,
  beginLocalDataClear,
  clearAqlBusinessState,
  isProjectExportInFlight,
  PROJECT_EXPORT_BLOCKS_CLEAR_MESSAGE,
  resetUiPreferences,
  useApp,
} from '../../store/appStore';
import {
  PROJECT_BACKUP_HINT,
  cancelPendingDatasetWork,
  quiescePendingDatasetWorkForClear,
  resumePendingDatasetWorkAfterClearFailure,
  useData,
} from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { errText, platform, type DatasetClearReceipt } from '../../platform/adapter';
import {
  deleteBrowserSnapshot,
  discardClearRecoveryMarker,
  isCommittedClearReceipt,
  persistClearRecoveryIntentBounded,
  recoverPendingClearOperation,
  restoreBrowserSnapshot,
  sweepOrphanClearRecoverySnapshot,
  updateClearRecoveryPhase,
  type BrowserDataSnapshot,
} from '../../platform/clearRecovery';
import { mesStop } from '../../platform/mes';
import { settleProjectImportRecoveryBeforeDataClear } from '../../platform/project';
import { KvRows } from '../common';
import { clearFishboneState } from '../../store/fishboneStore';

const QP_KEYS: Array<[string, string]> = [
  ['qp-dataset-v1', '活动数据集'],
  ['qp-recents-v1', '最近数据集'],
  ['qp-attr-v1', '计数图数据'],
  ['qp-specs-v1', '规格限记忆'],
  ['qp-fishbone-v1', '鱼骨图'],
  ['qp-analyses-v1', '已保存分析'],
  ['qp-analysis-data-v1', '分析数据快照'],
  ['qp-pareto-v1', '帕累托数据'],
  ['qp-active-ref-v1', '活动数据引用'],
  ['qp-copy-sequences-v1', '副本名称记录'],
  ['qp-quarantine-v1', '损坏数据隔离区'],
  [AQL_STATE_STORAGE_KEY, 'AQL 连续检验账本'],
  ['qp-prefs-v1', '界面偏好'],
];

function sizeOf(key: string): number {
  try {
    return (localStorage.getItem(key) ?? '').length * 2; // UTF-16 ≈ 2B/char
  } catch {
    return 0;
  }
}

const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);

/** 清库由 Rust 在单个 SQLite 事务中完成，不依赖 list，中途失败会整体回滚。 */
export async function removeAllVaultDatasetsBounded(
  db: NonNullable<typeof platform.datasetDb>,
  opId = newClearOperationId(),
): Promise<DatasetClearReceipt> {
  return db.clear(opId);
}

function newClearOperationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `clear-${uuid}` : `clear-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 捕获当前会被清除的全部浏览器数据。偏好键不在事务边界内。
 * 必须在任何 remove/db.clear 之前完成，读取失败时零修改返回。
 */
function snapshotBrowserBusinessData(): BrowserDataSnapshot {
  const keys = new Set(
    QP_KEYS.filter(([key]) => key !== 'qp-prefs-v1').map(([key]) => key),
  );
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(`${QUARANTINE_STORAGE_KEY}.corrupt-`)) keys.add(key);
  }
  const snapshot: Array<readonly [string, string]> = [];
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value !== null) snapshot.push([key, value]);
  }
  return snapshot;
}

type ClearFailureOutcome = 'not-committed' | 'unknown' | 'recovery-pending';

function clearFailure(message: string, cause: unknown, outcome: ClearFailureOutcome): Error {
  return Object.assign(new Error(message), { cause, clearOutcome: outcome });
}

function clearFailureOutcome(error: unknown): ClearFailureOutcome | null {
  if (typeof error !== 'object' || error === null) return null;
  const outcome = (error as { clearOutcome?: unknown }).clearOutcome;
  return outcome === 'not-committed' || outcome === 'unknown' || outcome === 'recovery-pending'
    ? outcome
    : null;
}

/**
 * 浏览器存储空间不足时的统一出路(fix2609l G22a / 5a G17a 尾巴):导入未持久化提示与本页常驻说明
 * 共用。IndexedDB 不可用时「清除数据」需先建立恢复点,空间不足同样会失败,所以首选出路是先移除
 * 最近数据集/已保存分析释放空间;「工具 → 选项」清除数据是次选。
 */
export const LOCAL_SPACE_RELEASE_HINT = '在左侧「最近数据集」移除不需要的条目，或删除不需要的已保存分析以释放浏览器存储空间';

function isRecoveryPointUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { recoveryPointUnavailable?: unknown }).recoveryPointUnavailable === true;
}

/** 未决清库必须在 reload 调用前先建立全局交互屏障；宿主拒绝 reload 时屏障仍保留。 */
export function blockUiForUnresolvedClear(
  error: unknown,
  reload: () => void = () => window.location.reload(),
): boolean {
  const outcome = clearFailureOutcome(error);
  if (outcome !== 'unknown' && outcome !== 'recovery-pending') return false;
  useApp.getState().setBusyOverlay('本地数据清除状态待恢复，正在重新启动；恢复完成前已禁止继续操作');
  try { reload(); } catch { /* 全局 busyOverlay 继续 fail-closed */ }
  return true;
}

/**
 * 浏览器存储 + SQLite 的可恢复清库：任何删除前先写有界恢复 marker；
 * Rust 原子 clear 通过同事务持久回执裁决。未知状态保留 marker，启动时
 * 在 store 水合前继续裁决，绝不把 IPC 失败误报成数据库回滚。
 */
export async function clearDurableBusinessDataAtomically(
  db: typeof platform.datasetDb,
): Promise<void> {
  // GAP-7-16 纵深防御：UI 入口已持有清库租约；直接调用者也不得在导出快照期间清库。
  if (isProjectExportInFlight()) {
    throw clearFailure(PROJECT_EXPORT_BLOCKS_CLEAR_MESSAGE, null, 'not-committed');
  }
  try {
    // 项目导入 journal 与清库恢复记录共享同一批业务 stores。
    // 必须先收口并清掉 localStorage/IndexedDB 两种 journal artifact，
    // 否则清库后崩溃可能被旧导入 journal 重新恢复数据。
    await settleProjectImportRecoveryBeforeDataClear();
  } catch (error) {
    throw clearFailure(
      `无法在清库前收口项目导入恢复记录：${errText(error)}`,
      error,
      'recovery-pending',
    );
  }
  const prior = await recoverPendingClearOperation(db);
  if (!prior.ready) {
    throw clearFailure(prior.error ?? '已有清库事务尚未完成裁决', prior.error, 'unknown');
  }
  const snapshot = snapshotBrowserBusinessData();
  const opId = newClearOperationId();
  // 存储接近配额时内联 marker 写不下，自动改用 IndexedDB 快照 + 小 marker（fix2609j PLATFORM-02）。
  const marker = await persistClearRecoveryIntentBounded(opId, snapshot);
  try {
    await commitBrowserAndVaultClear(db, opId, snapshot);
  } finally {
    // IndexedDB 快照是用户要求清除的数据：marker 已移除后立即清扫；未决（marker 仍在）时保留作恢复依据。
    if (marker.version !== 1) await sweepOrphanClearRecoverySnapshot();
  }
}

/** 恢复意图已持久化之后的删除 + SQLite 原子清库 + 裁决。 */
async function commitBrowserAndVaultClear(
  db: typeof platform.datasetDb,
  opId: string,
  snapshot: BrowserDataSnapshot,
): Promise<void> {
  try {
    deleteBrowserSnapshot(snapshot);
    updateClearRecoveryPhase(opId, 'browser-cleared');
  } catch (error) {
    const rollbackFailed = restoreBrowserSnapshot(snapshot);
    let markerFailed = false;
    if (rollbackFailed.length === 0) {
      try { discardClearRecoveryMarker(opId); } catch { markerFailed = true; }
    }
    const recovery = rollbackFailed.length === 0
      ? markerFailed
        ? '已恢复删除前的浏览器数据，本机数据集库未改动，但恢复记录仍保留，重新启动后会再次核验'
        : '已恢复删除前的浏览器数据，本机数据集库未改动'
      : `本机数据集库未改动，但浏览器备份恢复失败：${rollbackFailed.join('、')}`;
    throw clearFailure(
      `浏览器数据清除失败：${errText(error)}；${recovery}`,
      error,
      rollbackFailed.length === 0 && !markerFailed ? 'not-committed' : 'recovery-pending',
    );
  }

  if (!db) {
    // Web 端没有第二存储；marker 删除前崩溃会在下次启动恢复浏览器快照。
    try {
      discardClearRecoveryMarker(opId);
      return;
    } catch (error) {
      const rollbackFailed = restoreBrowserSnapshot(snapshot);
      throw clearFailure(
        `浏览器数据已删除，但恢复记录未能清除：${errText(error)}；${rollbackFailed.length === 0 ? '已回写删除前数据' : `仍有键待启动恢复：${rollbackFailed.join('、')}`}`,
        error,
        'recovery-pending',
      );
    }
  }
  let receipt: DatasetClearReceipt | null | undefined;
  let clearError: unknown = null;
  try {
    receipt = await removeAllVaultDatasetsBounded(db, opId);
  } catch (error) {
    clearError = error;
    // clear 可能已在 SQLite commit，只是 IPC 回复丢失。先查持久回执，
    // 查询也失败时再以同 opId 幂等重试一次。
    try {
      receipt = await db.clearStatus(opId);
    } catch (statusFailure) {
      clearError = statusFailure;
      try {
        receipt = await db.clear(opId);
      } catch (retryFailure) {
        clearError = retryFailure;
        receipt = undefined;
      }
    }
  }

  if (isCommittedClearReceipt(receipt, opId)) {
    // DB 提交是权威事实，不能恢复旧 browser；但 marker 删除也必须成为
    // 成功屏障。若继续运行并产生新数据，启动恢复会把同名新键当旧键删除。
    try {
      discardClearRecoveryMarker(opId);
    } catch (error) {
      throw clearFailure(
        `SQLite 清库已提交，但恢复记录未能清除：${errText(error)}；写入必须保持暂停，重新启动后将按持久回执收口`,
        error,
        'recovery-pending',
      );
    }
    return;
  }
  if (receipt === undefined || receipt !== null) {
    // 无回执或不匹配回执都属于未知；marker 自删除前已持久存在。
    throw clearFailure(
      `清库事务状态未知（${opId}）：${errText(clearError)}；为避免恢复已删数据，暂不恢复浏览器备份，应用将在重新启动时按持久回执裁决`,
      clearError,
      'unknown',
    );
  }

  // 明确 null 表示该 opId 未提交；只有完整恢复 browser 后才能移除 marker。
  const rollbackFailed = restoreBrowserSnapshot(snapshot);
  let markerFailed = false;
  if (rollbackFailed.length === 0) {
    try { discardClearRecoveryMarker(opId); } catch { markerFailed = true; }
  }
  const recovery = rollbackFailed.length === 0
    ? markerFailed
      ? 'SQLite 持久回执确认未提交，浏览器数据已恢复，但恢复记录未能清除，启动时会再次核验'
      : 'SQLite 持久回执确认未提交，浏览器数据已恢复'
    : `SQLite 持久回执确认未提交，但浏览器备份恢复失败：${rollbackFailed.join('、')}`;
  throw clearFailure(
    `本机数据集库清除失败：${errText(clearError)}；${recovery}`,
    clearError,
    rollbackFailed.length === 0 && !markerFailed ? 'not-committed' : 'recovery-pending',
  );
}

export function OptionsModal({ onClose }: { onClose: () => void }) {
  const { showToast, closeModal } = useApp();
  const resetDemo = useData((s) => s.resetDemo);
  const [clearArmed, setClearArmed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearBlocked, setClearBlocked] = useState<string | null>(null);
  const rows = useMemo(
    () => QP_KEYS.map(([k, label]) => ({ k: label, v: fmtSize(sizeOf(k)) })),
    [],
  );
  // 复审 P3:墓地键(qp-quarantine-v1.corrupt-*)也占配额,清除口径已按前缀扫描,
  // 统计口径必须一致,否则「占用 X」与实际清出的空间对不上
  const total = QP_KEYS.reduce((a, [k]) => a + sizeOf(k), 0)
    + Object.keys(localStorage).filter((k) => k.startsWith(`${QUARANTINE_STORAGE_KEY}.corrupt-`))
      .reduce((a, k) => a + (localStorage.getItem(k)?.length ?? 0), 0);

  const clearData = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      // 复审 P3:上一次被导出拒绝的原因只描述当时的状态；重新武装时清掉，
      // 否则导出早已结束，弹窗仍常驻「项目备份正在生成」误导用户。
      setClearBlocked(null);
      return;
    }
    if (clearing) return;
    // GAP-7-16:项目导出正在生成一致性快照时不得清库，否则备份读到半清空的库而失败，
    // 且清库尾段的数据集替换会撞上导出租约，把遮罩永久卡住。在建立遮罩前 fail-closed，
    // 并要求用户在导出完成后重新二次确认。
    let releaseClear: () => void;
    try {
      releaseClear = beginLocalDataClear();
    } catch (error) {
      const reason = errText(error);
      setClearArmed(false);
      setClearBlocked(reason);
      showToast(reason);
      return;
    }
    setClearBlocked(null);
    // 未决清库会整页重载进入启动屏障；在此之前继续持有租约，禁止任何导出读取未知状态。
    let keepClearLease = false;
    try {
      // 第二次确认就是清库事务的全局边界。遮罩在任何 await/
      // quiesce 之前建立，使背景点击、Escape 和应用快捷键立即不可达。
      useApp.getState().setBusyOverlay('正在停止后台写入并清除本地数据…');
      setClearing(true);
      mesStop();
      try {
        await quiescePendingDatasetWorkForClear();
      } catch (error) {
        resumePendingDatasetWorkAfterClearFailure();
        setClearing(false);
        showToast(`等待数据写入结束失败：${errText(error)}；未保存保护仍保留`);
        useApp.getState().setBusyOverlay(null);
        return;
      }
      try {
        await clearDurableBusinessDataAtomically(platform.datasetDb);
      } catch (error) {
        // 状态未知时保持 quiesced，防止 SQLite 已提交后旧 timer 又把数据写回。
        // 恢复 marker 未清理时也不能继续写，否则启动恢复会以旧快照覆盖新编辑。
        if (blockUiForUnresolvedClear(error)) {
          // dataStore quiesce 只能冻结 vault 归档，不能阻止 analyses/AQL/fishbone
          // 等其它 store 写 localStorage。立即重载进入 main 的启动屏障，才是全局
          // fail-closed；不能只留一个仍可关闭的 Options 弹窗。
          keepClearLease = true;
          setClearing(true);
          return;
        }
        resumePendingDatasetWorkAfterClearFailure();
        setClearing(false);
        // 恢复点因空间不足无法建立时，配额不变重试必然同样失败：错误本身已给出释放空间的出路，
        // 不再提示「再重试」（fix2609j PLATFORM-02）。
        showToast(isRecoveryPointUnavailable(error)
          ? `本地数据清除未提交：${errText(error)}；当前工作表已标记为未保存，建议先${PROJECT_BACKUP_HINT}备份`
          : `本地数据清除未提交：${errText(error)}；当前工作表已标记为未保存，请先${PROJECT_BACKUP_HINT}备份再重试`);
        useApp.getState().setBusyOverlay(null);
        return;
      }
      // SQLite 与浏览器存储都已确认清空后，才提交销毁待写载荷/dirty/隔离保护。
      try {
        cancelPendingDatasetWork();
        useAnalyses.setState({ saved: [], lastError: null });
        clearFishboneState();
        // 5b-2 G18 双保险:显式让鱼骨图页按新 revision 重挂载,不依赖 busyOverlay 起落的时序
        useApp.getState().bumpFishboneRevision();
        clearAqlBusinessState();
        try { localStorage.removeItem(AQL_STATE_STORAGE_KEY); } catch { /* 保持内存已清空 */ }
        resetDemo();
        useData.setState({ recents: [] });
      } catch (error) {
        // 复审 P3:清库已提交，收尾(内存 store 复位)抛错时 rejection 会被 void clearData() 吞掉；
        // 必须复位遮罩与 clearing，并如实说明数据已清除、只是界面未复位，否则界面永久卡在遮罩上。
        setClearing(false);
        setClearArmed(false);
        useApp.getState().setBusyOverlay(null);
        showToast(`数据已清除，但界面重置失败：${errText(error)}；请重启应用`);
        return;
      }
      closeModal();
      showToast('浏览器数据与本机数据集库已清除，已恢复演示数据集（界面偏好保留）');
      useApp.getState().setBusyOverlay(null);
    } finally {
      if (!keepClearLease) releaseClear();
    }
  };
  const resetPrefs = () => {
    resetUiPreferences();
    closeModal();
    showToast('界面偏好已重置（AQL 连续检验账本已保留）');
  };

  return (
    <div className="modal-panel options-modal" style={{ position: 'relative', width: 460, maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100dvh - 24px)', display: 'flex', flexDirection: 'column', background: '#fff', borderRadius: 10, boxShadow: '0 24px 60px rgba(10,20,40,0.32)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #edf0f3' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#26303c' }}>选项 · 本地数据</div>
        <button type="button" aria-label="关闭选项" disabled={clearing} onClick={() => {
          if (!clearing && !useApp.getState().busyOverlay) onClose();
        }} style={{ marginLeft: 'auto', border: 0, background: 'transparent', cursor: clearing ? 'wait' : 'pointer', color: '#9aa2ad', fontSize: 17 }}>✕</button>
      </div>
      <div className="modal-scroll-body" style={{ minHeight: 0, padding: '16px 20px', overflow: 'auto' }}>
        <div style={{ fontSize: 12.5, color: '#8a929d', marginBottom: 8 }}>
          所有数据保存在本机浏览器/应用存储中,合计 <b className="mono">{fmtSize(total)}</b>
        </div>
        <KvRows rows={rows} valueWeight={500} />
        <div className="options-modal-actions" style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="button" onClick={() => void clearData()} disabled={clearing} style={{ flex: 1, padding: '8px 0', textAlign: 'center', border: 0, background: '#c22f2f', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: clearing ? 'wait' : 'pointer' }}>
            {clearing ? '正在清除…' : clearArmed ? '再次点击确认彻底清除' : '清除数据并恢复演示'}
          </button>
          <button type="button" onClick={resetPrefs} disabled={clearing} style={{ flex: 1, padding: '8px 0', textAlign: 'center', background: '#fff', border: '1px solid #cfd5dd', color: '#5b6472', borderRadius: 5, fontSize: 12.5, cursor: clearing ? 'wait' : 'pointer' }}>
            重置界面偏好
          </button>
        </div>
        {clearBlocked && (
          <div role="alert" style={{ marginTop: 10, padding: '8px 10px', background: '#fff6e6', border: '1px solid #f0d69a', borderRadius: 5, fontSize: 12, color: '#8a6414', lineHeight: 1.55 }}>
            {clearBlocked}
          </div>
        )}
        <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 12, lineHeight: 1.5 }}>
          清除数据会同时移除浏览器数据、本机 SQLite 数据集库、分析快照、规格限记忆与鱼骨图内容；导出过的文件不受影响。为防误删，需要连续确认两次。
          浏览器存储已满且当前环境不支持 IndexedDB 时，清除前需要先{LOCAL_SPACE_RELEASE_HINT}。
        </div>
      </div>
    </div>
  );
}
