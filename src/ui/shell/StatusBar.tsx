/** 状态栏 — IBM Plex Mono 11.5px。 */
import { useApp } from '../../store/appStore';
import { nf } from '../../core';

export function StatusBar({ cpk, gageRR, gageDemo, wsName, rows, cols }: {
  cpk: number | null; gageRR: number | null; gageDemo?: boolean; wsName: string; rows: number; cols: number;
}) {
  const { chartStyle, cycleChartStyle } = useApp();
  return (
    <div className="mono" style={{ display: 'flex', alignItems: 'center', height: 26, background: '#f9fafb', borderTop: '1px solid #dadee4', padding: '0 14px', gap: 16, flex: 'none', fontSize: 11.5, color: '#7a828d' }}>
      <span style={{ color: '#2c8a45', fontWeight: 600 }}>● 就绪</span>
      <span>工作表: {wsName}</span>
      <span>行 {rows}</span>
      <span>列 {cols}</span>
      <span style={{ marginLeft: 'auto' }}>Cpk {cpk != null && Number.isFinite(cpk) ? nf(cpk, 2) : '—'}</span>
      <span>Gage R&R {gageRR != null && Number.isFinite(gageRR) ? `${nf(gageRR, 1)}%${gageDemo ? '（演示）' : ''}` : '—'}</span>
      <button type="button"
        className="hov-tool mono"
        onClick={cycleChartStyle}
        title="点击切换图表风格"
        style={{ cursor: 'pointer', border: 0, background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 'inherit', borderRadius: 3, padding: '1px 6px' }}
      >
        图表风格: {chartStyle} ▸
      </button>
    </div>
  );
}
