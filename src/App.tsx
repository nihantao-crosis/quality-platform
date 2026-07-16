/** 应用外壳 — 菜单栏 → 工具栏 → (左导航 + 主内容) → 状态栏 + 弹窗/Toast + 全局快捷键。 */
import { useEffect } from 'react';
import { useApp } from './store/appStore';
import { useData } from './store/dataStore';
import {
  capabilityInputError, computeCapability, computeGageRR, gageStudyData, GAGE_TOLERANCE, nf,
  prepareGageStudy, prepareSpcData, resolveNumericColumn,
} from './core';
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
import { Assistant } from './ui/pages/Assistant';
import { Summary } from './ui/pages/Summary';
import { Worksheet } from './ui/pages/Worksheet';
import { Spc } from './ui/pages/Spc';
import { Capability } from './ui/pages/Capability';
import { GageRR, Anova, Pareto } from './ui/pages/SimplePages';
import { Doe } from './ui/pages/Doe';
import { Aql } from './ui/pages/Aql';

export default function App() {
  const {
    page, openMenu, varOpen, setOpenMenu, setVarOpen, openModal, showToast, chartStyle, showGrid, lsl, usl, tgt, lslOn, busyOverlay, uslOn,
    spcType, spcDataLayout, spcValueCol, spcSubgroupCol, hypoTab, aqlLevel, aqlAQL,
    gageUseReal, gageValueName, gagePartName, gageOperatorName, activeVar,
  } = useApp();
  const { model: M, textCols, pendingCells } = useData();
  const T = chartTokens(chartStyle, showGrid);
  const cur = PAGES.find((p) => p.key === page) ?? PAGES[0];
  const preparedSpc = prepareSpcData(M, textCols, {
    layout: spcDataLayout, valueColumn: spcValueCol, subgroupColumn: spcSubgroupCol,
    pendingCells,
  });
  const capModel = preparedSpc.model;
  const capSpec = { lsl: lslOn ? lsl : null, tgt, usl: uslOn ? usl : null };
  const cap = capModel && capabilityInputError(capModel.all, capModel.sigmaWithin, capSpec) == null
    ? computeCapability(capModel.all, capModel.sigmaWithin, capSpec)
    : null;
  const preparedGage = prepareGageStudy(M, textCols, {
    valueColumn: gageValueName,
    partColumn: gagePartName,
    operatorColumn: gageOperatorName,
    pendingCells,
  });
  const requestedRealGage = !M.isDemo && gageUseReal;
  let gageRR: number | null = null;
  if (!requestedRealGage) {
    gageRR = computeGageRR(gageStudyData(), GAGE_TOLERANCE).totalGageRR;
  } else if (preparedGage.ok) {
    try {
      gageRR = computeGageRR(preparedGage.study.observations, lslOn && uslOn ? usl - lsl : null).totalGageRR;
    } catch { /* 状态栏显示未运行；页面负责给出具体原因 */ }
  }

  // 全局快捷键（菜单栏标注的 Ctrl+S/O/P/N;输入控件聚焦时不劫持）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useApp.getState().busyOverlay) { e.preventDefault(); return; } // 事务遮罩期间禁用全部快捷键
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
        }).catch((error) => s.showToast(`项目保存失败：${(error as Error).message}`));
      } else if (k === 'o') {
        e.preventDefault();
        s.openModal('import');
      } else if (k === 'f') {
        e.preventDefault();
        s.openModal('findreplace');
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
  const effectiveSpcType = !preparedSpc.error && preparedSpc.model && !preparedSpc.model.hasSubgroups
    && (spcType === 'xbar-r' || spcType === 'xbar-s') ? 'i-mr' : spcType;
  const spcTypeLabel = ({ 'xbar-r': 'X̄-R', 'xbar-s': 'X̄-S', 'i-mr': 'I-MR', ewma: 'EWMA', cusum: 'CUSUM', p: 'P 图', c: 'C 图' } as const)[effectiveSpcType];
  const summaryColumn = resolveNumericColumn(M, activeVar);
  const specLabel = lslOn && uslOn
    ? `${nf(lsl, 2)}–${nf(usl, 2)}`
    : lslOn ? `LSL ${nf(lsl, 2)}` : uslOn ? `USL ${nf(usl, 2)}` : '未启用';
  const dynTitle: Partial<Record<typeof page, string>> = {
    worksheet: `数据工作表 · ${M.name}`,
    summary: `描述性统计 · ${summaryColumn.name}`,
    spc: `SPC 控制图 · ${spcTypeLabel}`,
    anova: hypoTab === 'anova' ? '单因子方差分析'
      : hypoTab === 't1' ? '单样本 t 检验'
        : hypoTab === 't2' ? '双样本 t 检验（Welch）' : '相关与线性回归',
  };
  const title = dynTitle[page] ?? cur.title;
  const dynSub: Partial<Record<typeof page, string>> = {
    worksheet: `${M.k} 行 × ${M.colNames.length} 个数值列${textCols.length ? ` + ${textCols.length} 个文本列` : ''} · ${M.isDemo ? '直径 (mm)' : M.colNames.join(' / ')}`,
    spc: spcType === 'p' ? 'P 图 · 样本不良率'
      : spcType === 'c' ? 'C 图 · 单位缺陷数'
        : preparedSpc.error ? 'SPC 数据角色待配置'
          : preparedSpc.model?.hasSubgroups
            ? `子组控制图 · 子组大小 n = ${preparedSpc.model.n}`
            : '单值-移动极差控制图 · 单值序列',
    capability: preparedSpc.error ? '能力数据角色待配置' : `正态能力 · 规格 ${specLabel}`,
    gagerr: requestedRealGage
      ? preparedGage.ok
        ? `导入数据 · ${preparedGage.study.operatorLabels.length} 操作员 × ${preparedGage.study.partLabels.length} 部件 × ${preparedGage.study.repeats} 次`
        : `尚未运行 · ${preparedGage.reason}`
      : '演示研究 · 交叉设计 · ANOVA 法',
    aql: `GB/T 2828.1 · ${aqlLevel.startsWith('S-') ? '特殊' : '一般'}检验水平 ${aqlLevel} · AQL ${aqlAQL}`,
  };
  const subtitle = dynSub[page] ?? cur.sub;

  const rowSpcDisplayed = !preparedSpc.error && preparedSpc.layout === 'rows'
    && preparedSpc.model?.hasSubgroups === true && preparedSpc.model.k === M.k;
  const wsCols = M.colNames.length + textCols.length + 1 + (rowSpcDisplayed ? 2 : 0) + (M.isDemo ? 3 : 0);
  const analysisPage = page !== 'dashboard' && page !== 'assistant' && page !== 'worksheet';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', minWidth: 1180, background: '#eef0f3', fontSize: 13, overflow: 'hidden' }}>
      <MenuBar wsName={M.name} />
      <Toolbar />

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <SideNav />
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#eef0f3' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '14px 22px', background: '#fff', borderBottom: '1px solid #e0e4ea', flex: 'none' }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 600, color: '#26303c', letterSpacing: '-0.01em' }}>{title}</div>
              <div style={{ fontSize: 12.5, color: '#8a929d', marginTop: 2 }}>{subtitle}</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {analysisPage && <button type="button" className="hov-act" onClick={() => openModal('export')} style={{ padding: '7px 14px', border: '1px solid #cfd5dd', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: '#3a4350', background: '#fff', fontWeight: 500 }}>导出报表</button>}
              {analysisPage && <button
                type="button"
                className="hov-act-primary"
                title={page === 'aql'
                  ? '保存当前 AQL 方案与账本摘要；点击历史摘要只返回当前连续检验流，不会回滚活跃状态'
                  : '把当前分析保存为项目中的一条记录（可在仪表盘 / 项目管理器恢复）'}
                onClick={() => {
                  const saved = useAnalyses.getState().saveCurrent();
                  if (saved) showToast(`已保存分析「${saved.title}」到项目 · ${saved.metric}`);
                  else showToast(useAnalyses.getState().lastError ?? '当前页无可保存的分析,请先打开一个分析模块（SPC / 能力 / ANOVA…）');
                }}
                style={{ padding: '7px 14px', border: '1px solid #1f6fb2', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: '#fff', background: '#1f6fb2', fontWeight: 600 }}
              >
                {page === 'aql' ? '保存当前摘要' : '保存到项目'}
              </button>}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px 40px' }}>
            <ErrorBoundary resetKey={page + '|' + M.name}>
              {page === 'dashboard' && <Dashboard T={T} />}
              {page === 'assistant' && <Assistant />}
              {page === 'summary' && <Summary T={T} />}
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
      {busyOverlay && (
        <div role="alert" aria-busy="true" tabIndex={-1} ref={(el) => el?.focus()} onKeyDown={(e) => e.preventDefault()} style={{ position: 'fixed', inset: 0, zIndex: 1000, outline: 'none', background: 'rgba(20,28,40,0.62)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 8, padding: '22px 34px', fontSize: 14, color: '#33404f', fontWeight: 600, boxShadow: '0 8px 30px rgba(0,0,0,0.25)' }}>
            {busyOverlay}
          </div>
        </div>
      )}
      <SessionPanel />
      <StatusBar cpk={cap?.cpk ?? null} gageRR={gageRR} gageDemo={!requestedRealGage} wsName={M.name} rows={M.k} cols={wsCols} />
    </div>
  );
}
