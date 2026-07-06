/** 选项 / 本地数据 — 存储占用一览、清除数据、重置偏好。 */
import { useMemo } from 'react';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { KvRows } from '../common';

const QP_KEYS: Array<[string, string]> = [
  ['qp-dataset-v1', '活动数据集'],
  ['qp-recents-v1', '最近数据集'],
  ['qp-attr-v1', '计数图数据'],
  ['qp-specs-v1', '规格限记忆'],
  ['qp-fishbone-v1', '鱼骨图'],
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
  const rows = useMemo(
    () => QP_KEYS.map(([k, label]) => ({ k: label, v: fmtSize(sizeOf(k)) })),
    [],
  );
  const total = QP_KEYS.reduce((a, [k]) => a + sizeOf(k), 0);

  const clearData = () => {
    try {
      QP_KEYS.forEach(([k]) => k !== 'qp-prefs-v1' && localStorage.removeItem(k));
    } catch { /* 忽略 */ }
    resetDemo();
    closeModal();
    showToast('本地数据已清除,已恢复演示数据集(界面偏好保留)');
  };
  const resetPrefs = () => {
    try {
      localStorage.removeItem('qp-prefs-v1');
    } catch { /* 忽略 */ }
    closeModal();
    showToast('界面偏好已重置,刷新页面后生效');
  };

  return (
    <div style={{ position: 'relative', width: 460, background: '#fff', borderRadius: 10, boxShadow: '0 24px 60px rgba(10,20,40,0.32)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #edf0f3' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#26303c' }}>选项 · 本地数据</div>
        <div onClick={onClose} style={{ marginLeft: 'auto', cursor: 'pointer', color: '#9aa2ad', fontSize: 17 }}>✕</div>
      </div>
      <div style={{ padding: '16px 20px' }}>
        <div style={{ fontSize: 12.5, color: '#8a929d', marginBottom: 8 }}>
          所有数据保存在本机浏览器/应用存储中,合计 <b className="mono">{fmtSize(total)}</b>
        </div>
        <KvRows rows={rows} valueWeight={500} />
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <div onClick={clearData} style={{ flex: 1, padding: '8px 0', textAlign: 'center', background: '#c22f2f', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
            清除数据并恢复演示
          </div>
          <div onClick={resetPrefs} style={{ flex: 1, padding: '8px 0', textAlign: 'center', border: '1px solid #cfd5dd', color: '#5b6472', borderRadius: 5, fontSize: 12.5, cursor: 'pointer' }}>
            重置界面偏好
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 12, lineHeight: 1.5 }}>
          清除数据会移除导入的数据集、最近列表、规格限记忆与鱼骨图内容;导出过的文件不受影响。
        </div>
      </div>
    </div>
  );
}
