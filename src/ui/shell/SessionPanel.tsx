/** 会话窗口面板 — 底部可折叠日志,复制/清空/关闭。 */
import { useEffect, useRef } from 'react';
import { useSessionLog } from '../../store/sessionLog';
import { useApp } from '../../store/appStore';

export function SessionPanel() {
  const { entries, visible, clear, toggle } = useSessionLog();
  const showToast = useApp((s) => s.showToast);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visible && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [entries, visible]);

  if (!visible) return null;

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(entries.join('\n'));
      showToast('会话日志已复制到剪贴板');
    } catch {
      showToast('复制失败（剪贴板权限受限）');
    }
  };

  return (
    <div className="no-print" style={{ flex: 'none', background: '#fff', borderTop: '1px solid #dadee4', display: 'flex', flexDirection: 'column', height: 150 }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '5px 14px', borderBottom: '1px solid #edf0f3', gap: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#33404f' }}>会话窗口</span>
        <span className="mono" style={{ fontSize: 10.5, color: '#a3abb5' }}>{entries.length} 条</span>
        <span onClick={copyAll} style={{ marginLeft: 'auto', fontSize: 11.5, color: '#1f6fb2', cursor: 'pointer' }}>复制</span>
        <span onClick={clear} style={{ fontSize: 11.5, color: '#8a929d', cursor: 'pointer' }}>清空</span>
        <span onClick={toggle} style={{ fontSize: 13, color: '#9aa2ad', cursor: 'pointer' }}>✕</span>
      </div>
      <div ref={bodyRef} className="mono" style={{ flex: 1, overflowY: 'auto', padding: '6px 14px', fontSize: 11.5, lineHeight: 1.7, color: '#3a4350' }}>
        {entries.map((e, i) => (
          <div key={i}>{e}</div>
        ))}
      </div>
    </div>
  );
}
