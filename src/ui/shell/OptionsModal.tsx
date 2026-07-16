/** 选项 / 本地数据 — 存储占用一览、清除数据、重置偏好。 */
import { useMemo, useState } from 'react';
import { AQL_STATE_STORAGE_KEY, clearAqlBusinessState, resetUiPreferences, useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, settlePendingDatasetWrites, useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { platform } from '../../platform/adapter';
import { mesStop } from '../../platform/mes';
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

export function OptionsModal({ onClose }: { onClose: () => void }) {
  const { showToast, closeModal } = useApp();
  const resetDemo = useData((s) => s.resetDemo);
  const [clearArmed, setClearArmed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const rows = useMemo(
    () => QP_KEYS.map(([k, label]) => ({ k: label, v: fmtSize(sizeOf(k)) })),
    [],
  );
  const total = QP_KEYS.reduce((a, [k]) => a + sizeOf(k), 0);

  const clearData = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    if (clearing) return;
    setClearing(true);
    mesStop();
    cancelPendingDatasetWork();
    await settlePendingDatasetWrites();
    const db = platform.datasetDb;
    if (db) {
      try {
        const datasets = await db.list();
        const results = await Promise.all(datasets.map((dataset) => db.remove(dataset.name)));
        if (results.some((removed) => !removed)) throw new Error('部分数据集未能删除');
      } catch (error) {
        setClearing(false);
        showToast(`本机数据集库清除不完整：${(error as Error).message}；浏览器数据尚未清除`);
        return;
      }
    }
    try {
      QP_KEYS.forEach(([k]) => k !== 'qp-prefs-v1' && localStorage.removeItem(k));
    } catch (error) {
      setClearing(false);
      showToast(`浏览器数据清除失败：${(error as Error).message}`);
      return;
    }
    useAnalyses.setState({ saved: [], lastError: null });
    clearFishboneState();
    clearAqlBusinessState();
    try { localStorage.removeItem(AQL_STATE_STORAGE_KEY); } catch { /* 保持内存已清空 */ }
    resetDemo();
    useData.setState({ recents: [] });
    closeModal();
    showToast('浏览器数据与本机数据集库已清除，已恢复演示数据集（界面偏好保留）');
  };
  const resetPrefs = () => {
    resetUiPreferences();
    closeModal();
    showToast('界面偏好已重置（AQL 连续检验账本已保留）');
  };

  return (
    <div style={{ position: 'relative', width: 460, background: '#fff', borderRadius: 10, boxShadow: '0 24px 60px rgba(10,20,40,0.32)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #edf0f3' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#26303c' }}>选项 · 本地数据</div>
        <button type="button" aria-label="关闭选项" onClick={onClose} style={{ marginLeft: 'auto', border: 0, background: 'transparent', cursor: 'pointer', color: '#9aa2ad', fontSize: 17 }}>✕</button>
      </div>
      <div style={{ padding: '16px 20px' }}>
        <div style={{ fontSize: 12.5, color: '#8a929d', marginBottom: 8 }}>
          所有数据保存在本机浏览器/应用存储中,合计 <b className="mono">{fmtSize(total)}</b>
        </div>
        <KvRows rows={rows} valueWeight={500} />
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="button" onClick={() => void clearData()} disabled={clearing} style={{ flex: 1, padding: '8px 0', textAlign: 'center', border: 0, background: '#c22f2f', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: clearing ? 'wait' : 'pointer' }}>
            {clearing ? '正在清除…' : clearArmed ? '再次点击确认彻底清除' : '清除数据并恢复演示'}
          </button>
          <button type="button" onClick={resetPrefs} style={{ flex: 1, padding: '8px 0', textAlign: 'center', background: '#fff', border: '1px solid #cfd5dd', color: '#5b6472', borderRadius: 5, fontSize: 12.5, cursor: 'pointer' }}>
            重置界面偏好
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 12, lineHeight: 1.5 }}>
          清除数据会同时移除浏览器数据、本机 SQLite 数据集库、分析快照、规格限记忆与鱼骨图内容；导出过的文件不受影响。为防误删，需要连续确认两次。
        </div>
      </div>
    </div>
  );
}
