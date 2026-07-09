/** 应用外壳 — 菜单栏 → 工具栏 → (左导航 + 主内容) → 状态栏 + 弹窗/Toast + 全局快捷键。 */
import { useEffect, useMemo } from 'react';
import { useApp } from './store/appStore';
import { useData } from './store/dataStore';
import { computeCapability, computeGageRR, gageStudyData, GAGE_TOLERANCE, nf } from './core';
import { platform } from './platform/adapter';
import { exportProject } from './platform/project';
import { useAnalyses } from './store/analyses';
import { chartTokens } from './ui/tokens';
import { PAGES } from './ui/pagesMeta';
import { MenuBar } from './ui/shell/MenuBar';
import { Toolbar } from './ui/shell/Toolbar';
import { SideNav } from './ui/shell/SideNav';
import { StatusBar } from './ui/shell/StatusBar';
import { Modals, Toast } from './ui/shell/Modals';
import { SessionPanel } from './ui/shell/SessionPanel';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { Dashboard } from './ui/pages/Dashboard';
import { Worksheet } from './ui/pages/Worksheet';
import { Spc } from './ui/pages/Spc';
import { Capability } from './ui/pages/Capability';
import { GageRR, Anova, Pareto } from './ui/pages/SimplePages';
import { Doe } from './ui/pages/Doe';
import { Aql } from './ui/pages/Aql';

export default function App() {
  const { page, openMenu, varOpen, setOpenMenu, setVarOpen, openModal, showToast, chartStyle, showGrid, lsl, usl, tgt } = useApp();
  const M = useData((s) => s.model);
  const T = chartTokens(chartStyle, showGrid);
  const cur = PAGES.find((p) => p.key === page) ?? PAGES[0];
  const cap = computeCapability(M.all, M.sigmaWithin, { lsl, tgt, usl });
  const gage = useMemo(() => computeGageRR(gageStudyData(), GAGE_TOLERANCE), []);

  // 全局快捷键（菜单栏标注的 Ctrl+S/O/P/N;输入控件聚焦时不劫持）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        useApp.getState().openModal('help');
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const s = useApp.getState();
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        exportProject(__APP_VERSION__, useApp.getState().projectName).then((dest) => {
          if (dest) s.showToast('项目已保存: ' + dest);
        });
      } else if (k === 'o') {
        e.preventDefault();
        s.openModal('import');
      } else if (k === 'p') {
        e.preventDefault();
        if (platform.isDesktop) s.showToast('桌面端请使用「导出报表」生成文件后打印');
        else setTimeout(() => window.print(), 80);
      } else if (k === 'n') {
        e.preventDefault();
        useData.getState().newWorksheet();
        s.goTo('worksheet');
        s.showToast('已新建空白工作表（双击单元格录入数据）');
      } else if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        s.showToast(useData.getState().undoEdit() ? '已撤销上一次数据编辑' : '没有可撤销的编辑');
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        s.showToast(useData.getState().redoEdit() ? '已重做数据编辑' : '没有可重做的编辑');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 数据相关页面的副标题跟随活动数据集
  const dynSub: Partial<Record<typeof page, string>> = {
    worksheet: `${M.k} 子组 × ${M.n} 测量值 · ${M.isDemo ? '直径 (mm)' : M.colNames.join(' / ')}`,
    spc: M.hasSubgroups ? `均值-极差控制图 · 子组大小 n = ${M.n}` : '单值-移动极差控制图 · 单列数据',
    capability: `正态能力 · 规格 ${nf(lsl, 2)}–${nf(usl, 2)}`,
  };
  const subtitle = dynSub[page] ?? cur.sub;

  const wsCols = M.colNames.length + 1 + (M.hasSubgroups ? 2 : 0) + (M.isDemo ? 3 : 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', minWidth: 1180, background: '#eef0f3', fontSize: 13, overflow: 'hidden' }}>
      <MenuBar wsName={M.name} />
      <Toolbar />

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <SideNav />
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#eef0f3' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '14px 22px', background: '#fff', borderBottom: '1px solid #e0e4ea', flex: 'none' }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 600, color: '#26303c', letterSpacing: '-0.01em' }}>{cur.title}</div>
              <div style={{ fontSize: 12.5, color: '#8a929d', marginTop: 2 }}>{subtitle}</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="hov-act" onClick={() => openModal('export')} style={{ padding: '7px 14px', border: '1px solid #cfd5dd', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, color: '#3a4350', background: '#fff', fontWeight: 500 }}>导出报表</div>
              <div
                className="hov-act-primary"
                title="把当前分析保存为项目中的一条记录（可在仪表盘 / 项目管理器回看）"
                onClick={() => {
                  const saved = useAnalyses.getState().saveCurrent();
                  if (saved) showToast(`已保存分析「${saved.title}」到项目 · ${saved.metric}`);
                  else showToast('当前页无可保存的分析,请先打开一个分析模块（SPC / 能力 / ANOVA…）');
                }}
                style={{ padding: '7px 14px', border: '1px solid #1f6fb2', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, color: '#fff', background: '#1f6fb2', fontWeight: 600 }}
              >
                保存到项目
              </div>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px 40px' }}>
            <ErrorBoundary resetKey={page + '|' + M.name}>
              {page === 'dashboard' && <Dashboard T={T} />}
              {page === 'worksheet' && <Worksheet />}
              {page === 'spc' && <Spc T={T} />}
              {page === 'capability' && <Capability T={T} />}
              {page === 'gagerr' && <GageRR T={T} />}
              {page === 'anova' && <Anova T={T} />}
              {page === 'pareto' && <Pareto T={T} />}
              {page === 'doe' && <Doe T={T} />}
              {page === 'aql' && <Aql T={T} />}
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {openMenu != null && <div onClick={() => setOpenMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 55 }} />}
      {varOpen && <div onClick={() => setVarOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />}

      <Modals />
      <Toast />
      <SessionPanel />
      <StatusBar cpk={cap.cpk} gageRR={gage.totalGageRR} wsName={M.name} rows={M.k} cols={wsCols} />
    </div>
  );
}
