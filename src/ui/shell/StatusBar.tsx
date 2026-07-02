/** 状态栏 — IBM Plex Mono 11.5px。 */
import { useApp } from '../../store/appStore';
import { nf } from '../../core';

export function StatusBar({ cpk }: { cpk: number }) {
  const chartStyle = useApp((s) => s.chartStyle);
  return (
    <div className="mono" style={{ display: 'flex', alignItems: 'center', height: 26, background: '#f9fafb', borderTop: '1px solid #dadee4', padding: '0 14px', gap: 16, flex: 'none', fontSize: 11.5, color: '#7a828d' }}>
      <span style={{ color: '#2c8a45', fontWeight: 600 }}>● 就绪</span>
      <span>工作表: 质检数据.mtw</span>
      <span>行 125</span>
      <span>列 11</span>
      <span style={{ marginLeft: 'auto' }}>Cpk {nf(cpk, 2)}</span>
      <span>Gage R&R 8.4%</span>
      <span>图表风格: {chartStyle}</span>
    </div>
  );
}
