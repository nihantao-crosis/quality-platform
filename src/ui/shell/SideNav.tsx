/** 左侧导航 — 分组导航 + 徽标 + 项目管理器树。 */
import { useApp } from '../../store/appStore';
import { PAGES } from '../pagesMeta';
import { Icon } from '../icons';

const GROUPS = ['仪表盘', '数据', '分析模块'] as const;

export function SideNav() {
  const { page, goTo } = useApp();

  return (
    <aside style={{ width: 242, flex: 'none', background: '#fbfcfd', borderRight: '1px solid #dadee4', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      {GROUPS.map((g, gi) => (
        <div key={g}>
          <div style={{ padding: gi === 0 ? '14px 16px 8px' : '10px 16px 5px', fontSize: 11, letterSpacing: '0.06em', color: '#98a1ac', fontWeight: 600 }}>{g}</div>
          {PAGES.filter((p) => p.group === g).map((p) => {
            const active = page === p.key;
            return (
              <div
                key={p.key}
                className={active ? 'hov-nav-active' : 'hov-nav'}
                onClick={() => goTo(p.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, margin: '1px 8px', padding: '8px 10px',
                  borderRadius: 5, cursor: 'pointer', fontSize: 13,
                  ...(active
                    ? { background: '#e7f0f9', color: '#1f6fb2', fontWeight: 600, borderLeft: '3px solid #1f6fb2' }
                    : { color: '#4a5462', borderLeft: '3px solid transparent' }),
                }}
              >
                <span style={{ display: 'inline-flex', width: 18, justifyContent: 'center', opacity: 0.9 }}>
                  <Icon name={p.icon} color={active ? '#1f6fb2' : '#7a828d'} />
                </span>
                <span style={{ flex: 1 }}>{p.label}</span>
                {p.key === 'spc' && (
                  <span className="mono" style={{ background: '#e23b3b', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 9 }}>2</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div style={{ marginTop: 'auto', borderTop: '1px solid #e6e9ee', padding: '12px 16px' }}>
        <div style={{ fontSize: 11, letterSpacing: '0.06em', color: '#98a1ac', fontWeight: 600, marginBottom: 8 }}>项目管理器</div>
        <div style={{ fontSize: 12, color: '#5b6472', lineHeight: 1.9 }}>
          <div>📁 质检项目 2026-Q2</div>
          <div style={{ paddingLeft: 16, color: '#7a828d' }}>工作表 · 质检数据.mtw</div>
          <div style={{ paddingLeft: 16, color: '#7a828d' }}>分析 · 4 项已保存</div>
        </div>
      </div>
    </aside>
  );
}
