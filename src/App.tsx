/** 应用外壳 — 菜单栏 → 工具栏 → (左导航 + 主内容) → 状态栏 + 弹窗/Toast。 */
import { useApp } from './store/appStore';
import { DATA } from './dataModel';
import { chartTokens } from './ui/tokens';
import { PAGES } from './ui/pagesMeta';
import { MenuBar } from './ui/shell/MenuBar';
import { Toolbar } from './ui/shell/Toolbar';
import { SideNav } from './ui/shell/SideNav';
import { StatusBar } from './ui/shell/StatusBar';
import { Modals, Toast } from './ui/shell/Modals';
import { Dashboard } from './ui/pages/Dashboard';
import { Worksheet } from './ui/pages/Worksheet';
import { Spc } from './ui/pages/Spc';
import { Capability } from './ui/pages/Capability';
import { GageRR, Anova, Pareto } from './ui/pages/SimplePages';
import { Doe } from './ui/pages/Doe';
import { Aql } from './ui/pages/Aql';

export default function App() {
  const { page, openMenu, varOpen, setOpenMenu, setVarOpen, openModal, showToast, chartStyle, showGrid } = useApp();
  const M = DATA;
  const T = chartTokens(chartStyle, showGrid);
  const cur = PAGES.find((p) => p.key === page) ?? PAGES[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', minWidth: 1180, background: '#eef0f3', fontSize: 13, overflow: 'hidden' }}>
      <MenuBar />
      <Toolbar />

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <SideNav />
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#eef0f3' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '14px 22px', background: '#fff', borderBottom: '1px solid #e0e4ea', flex: 'none' }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 600, color: '#26303c', letterSpacing: '-0.01em' }}>{cur.title}</div>
              <div style={{ fontSize: 12.5, color: '#8a929d', marginTop: 2 }}>{cur.sub}</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="hov-act" onClick={() => openModal('export')} style={{ padding: '7px 14px', border: '1px solid #cfd5dd', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, color: '#3a4350', background: '#fff', fontWeight: 500 }}>导出报表</div>
              <div className="hov-act-primary" onClick={() => showToast('已保存到项目 · 质检项目 2026-Q2')} style={{ padding: '7px 14px', border: '1px solid #1f6fb2', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, color: '#fff', background: '#1f6fb2', fontWeight: 600 }}>保存到项目</div>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px 40px' }}>
            {page === 'dashboard' && <Dashboard M={M} T={T} />}
            {page === 'worksheet' && <Worksheet M={M} />}
            {page === 'spc' && <Spc M={M} T={T} />}
            {page === 'capability' && <Capability M={M} T={T} />}
            {page === 'gagerr' && <GageRR T={T} />}
            {page === 'anova' && <Anova T={T} />}
            {page === 'pareto' && <Pareto T={T} />}
            {page === 'doe' && <Doe T={T} />}
            {page === 'aql' && <Aql T={T} />}
          </div>
        </main>
      </div>

      {openMenu != null && <div onClick={() => setOpenMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 55 }} />}
      {varOpen && <div onClick={() => setVarOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />}

      <Modals />
      <Toast />
      <StatusBar cpk={M.Cpk} />
    </div>
  );
}
