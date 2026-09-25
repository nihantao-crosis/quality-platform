/** 应用外壳 — 菜单栏 → 工具栏 → (左导航 + 主内容) → 状态栏 + 弹窗/Toast + 全局快捷键。 */
import { useEffect, useMemo, useState } from 'react';
import { useApp, resolveGageTolerance } from './store/appStore';
import { useData, isCapabilityWarningAcknowledged } from './store/dataStore';
import {
  capabilityInputError, computeCapability, computeGageRR, gageStudyData, GAGE_TOLERANCE,
  peekResolvedGageStudy, resolveGageStudy, prepareSpcData, resolveNumericColumn,
  type GageStudyPreparation,
} from './core';
import { errText, platform } from './platform/adapter';
import { exportProject } from './platform/project';
import { useAnalyses } from './store/analyses';
import { chartTokens } from './ui/tokens';
import { useCapabilityPrepared } from './ui/useCapabilityPrepared';
import { specLimitText } from './platform/reportLabels';
import { PAGES } from './ui/pagesMeta';
import { MenuBar, runNewWorksheet, undoRedoToast } from './ui/shell/MenuBar';
import { Toolbar } from './ui/shell/Toolbar';
import { SideNav } from './ui/shell/SideNav';
import { StatusBar } from './ui/shell/StatusBar';
import { Modals, Toast } from './ui/shell/Modals';
import { SessionPanel } from './ui/shell/SessionPanel';
import { ErrorBoundary, recoverDemoDataset } from './ui/ErrorBoundary';
import { Dashboard } from './ui/pages/Dashboard';
import { Assistant } from './ui/pages/Assistant';
import { Summary } from './ui/pages/Summary';
import { Worksheet } from './ui/pages/Worksheet';
import { Spc } from './ui/pages/Spc';
import { Capability } from './ui/pages/Capability';
import { GageRR, Anova, Pareto } from './ui/pages/SimplePages';
import { Doe } from './ui/pages/Doe';
import { Aql } from './ui/pages/Aql';

const APPLICATION_SHORTCUT_KEYS = new Set(['n', 'z', 'y', 's', 'o', 'p', 'f']);

/**
 * 全局命令不得吞掉编辑器自身的撤销/重做等按键。closest 同时覆盖事件落在
 * input 内图标/包装节点、或 contenteditable 的任意后代节点这两类情况。
 */
function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const editor = target.closest('input, textarea, select, [contenteditable]');
  if (!editor) return false;
  return !editor.hasAttribute('contenteditable') || editor.getAttribute('contenteditable') !== 'false';
}

const shellButton = { padding: '7px 16px', borderRadius: 5, fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer' } as const;

/**
 * fix2609c UI-02:壳层错误卡。App 函数体(派生计算)、菜单栏/工具栏/状态栏/会话面板等任一渲染期异常
 * 不再卸载整棵树;本卡片不依赖已崩溃的壳层组件,只用 store 动作提供逃生入口。
 */
function ShellCrashCard({ error, reset }: { error: Error; reset: () => void }) {
  const [exportNote, setExportNote] = useState('');
  return (
    <div role="alert" style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#eef0f3', fontSize: 13 }}>
      <div style={{ background: '#fff', border: '1px solid #f0d3d3', borderRadius: 6, padding: '28px 32px', maxWidth: 560, boxShadow: '0 4px 18px rgba(20,30,50,0.08)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#c22f2f', marginBottom: 8 }}>应用界面渲染出错</div>
        <div className="mono" style={{ fontSize: 12, color: '#8a929d', marginBottom: 16, whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>
          {error.message}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={reset} style={{ ...shellButton, border: 0, background: '#1f6fb2', color: '#fff', fontWeight: 600 }}>
            重试
          </button>
          <button type="button"
            onClick={() => {
              exportProject(__APP_VERSION__, useApp.getState().projectName)
                .then((dest) => setExportNote(dest ? `项目已保存: ${dest}` : ''))
                .catch((exportError) => setExportNote(`项目保存失败：${errText(exportError)}`));
            }}
            style={{ ...shellButton, border: '1px solid #cfd5dd', background: '#fff', color: '#3a4350' }}
          >
            保存项目文件
          </button>
          <button type="button"
            onClick={() => {
              const recoverError = recoverDemoDataset();
              if (recoverError) setExportNote(recoverError);
              else reset();
            }}
            style={{ ...shellButton, border: '1px solid #cfd5dd', background: '#fff', color: '#5b6472' }}
          >
            恢复演示数据集并重试
          </button>
        </div>
        {exportNote && <div style={{ fontSize: 12, color: '#3a4350', marginTop: 12 }}>{exportNote}</div>}
        <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 14, lineHeight: 1.6 }}>
          若反复出现,可能是当前数据集或角色选择异常:可先保存项目文件留底,再恢复演示数据集继续使用。
        </div>
      </div>
    </div>
  );
}

/** fix2609c UI-02:对话框层独立边界——对话框渲染异常只替换对话框本身,关闭即复位。 */
function ModalCrashCard({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alertdialog" aria-label="对话框渲染出错" style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(20,28,40,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 6, padding: '22px 28px', maxWidth: 480, boxShadow: '0 8px 30px rgba(0,0,0,0.2)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#c22f2f', marginBottom: 8 }}>对话框渲染出错</div>
        <div className="mono" style={{ fontSize: 12, color: '#8a929d', marginBottom: 14, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
          {error.message}
        </div>
        <button type="button"
          onClick={() => {
            useApp.getState().closeModal();
            reset();
          }}
          style={{ ...shellButton, border: 0, background: '#1f6fb2', color: '#fff', fontWeight: 600 }}
        >
          关闭对话框
        </button>
      </div>
    </div>
  );
}

/**
 * 根级错误边界包住整个壳层(fix2609c UI-02):含 AppShell 函数体内的派生计算。
 * resetKey 与页面级边界同源(页面 + 数据集),切换数据集(如「恢复演示数据集」)时自动复位。
 */
export default function App() {
  const page = useApp((s) => s.page);
  const wsName = useData((s) => s.model.name);
  return (
    <ErrorBoundary resetKey={page + '|' + wsName} fallback={(error, reset) => <ShellCrashCard error={error} reset={reset} />}>
      <AppShell />
    </ErrorBoundary>
  );
}

function AppShell() {
  const {
    page, modal, openMenu, varOpen, setOpenMenu, setVarOpen, openModal, showToast, chartStyle, showGrid, lsl, usl, tgt, lslOn, busyOverlay, uslOn,
    spcType, spcDataLayout, spcValueCol, spcSubgroupCol, hypoTab, aqlLevel, aqlAQL, aqlRegime,
    gageUseReal, gageValueName, gagePartName, gageOperatorName, gageTolMode, gageTolValue, activeVar,
    capabilityWarningAcknowledgement,
  } = useApp();
  const { model: M, textCols, pendingCells } = useData();
  const T = chartTokens(chartStyle, showGrid);
  const cur = PAGES.find((p) => p.key === page) ?? PAGES[0];
  // 记忆化(双审 P2):O(N) 解析不得在每次任意 UI 状态变化时全量重跑(20 万行下每帧数百毫秒)。
  // 同函数体内 preparedCap 早已 useMemo,此处对齐同一纪律。
  const preparedSpc = useMemo(
    () => prepareSpcData(M, textCols, {
      layout: spcDataLayout, valueColumn: spcValueCol, subgroupColumn: spcSubgroupCol,
      pendingCells,
    }),
    [M, textCols, pendingCells, spcDataLayout, spcValueCol, spcSubgroupCol],
  );
  // 批次716-R3:壳层能力指标(能力页副标题/状态栏 Cpk)改走能力口径解析,与能力页/
  // 保存记录/专项报告完全同源;SPC 副标题与工作表列数仍使用上面的 preparedSpc,互不串扰。
  // resolver 内部含 prepareSpcData 成本,按口径输入记忆化,避免每次渲染重复解析;
  // resolver 从 store 内部读取以下口径/角色字段,依赖需手工列全以便口径变化时失效。
  // fix2609i G14:依赖清单统一由 useCapabilityPrepared 维护(与能力页/总览共用),不再各处手抄。
  const { prepared: preparedCap } = useCapabilityPrepared();
  // GAP-10-22 复审 P2:AppShell 全量订阅 store,toast/菜单等任意变化都会重渲染壳层。确认指纹
  // (内部再解析能力口径 + 全量指纹)与能力计算都是 O(N),与 Dashboard 同写法一并记忆化;
  // preparedCap 已随全部能力口径字段失效,依赖它即覆盖 resolver 从 store 读取的字段。
  const cap = useMemo(() => {
    const capModel = preparedCap.model;
    if (!capModel) return null;
    const capSpec = { lsl: lslOn ? lsl : null, tgt, usl: uslOn ? usl : null };
    const capWarningAcknowledged = isCapabilityWarningAcknowledged(
      M, textCols, capModel, capSpec, capabilityWarningAcknowledgement,
    );
    return capabilityInputError(capModel.all, capModel.sigmaWithin, capSpec, { allowDistantSpec: capWarningAcknowledged }) == null
      ? computeCapability(capModel.all, capModel.sigmaWithin, capSpec, { allowDistantSpec: capWarningAcknowledged })
      : null;
  }, [M, textCols, preparedCap, lsl, usl, tgt, lslOn, uslOn, capabilityWarningAcknowledgement]);
  // Gage 角色经 effectiveGageSelection 与 MSA 页同源(未手选时用推荐,不再按列序猜)。
  // fix2609c CORE-02/03:壳层不再每次渲染无条件解析 Gage 研究——只在启用导入数据且位于 MSA 页时
  // 按需解析(与页面共享单槽记忆);其他页只读已算好的结果,输入变了就显示「未运行」。异常降级为未运行。
  const requestedRealGage = !M.isDemo && gageUseReal;
  const preparedGage = useMemo<GageStudyPreparation | null>(() => {
    if (!requestedRealGage) return null;
    const stored = { value: gageValueName, part: gagePartName, operator: gageOperatorName };
    try {
      const resolved = page === 'gagerr'
        ? resolveGageStudy(M, textCols, stored, pendingCells)
        : peekResolvedGageStudy(M, textCols, stored, pendingCells);
      return resolved?.prepared ?? null;
    } catch (error) {
      return { ok: false, reason: `Gage 数据解析失败：${errText(error)}` };
    }
  }, [requestedRealGage, page, M, textCols, pendingCells, gageValueName, gagePartName, gageOperatorName]);
  // 同一阻塞路径:状态栏 %GRR 的 ANOVA 同样随输入记忆化,不随 toast/菜单重算。
  const gageRR = useMemo<number | null>(() => {
    if (!requestedRealGage) {
      return computeGageRR(gageStudyData(), { mode: 'width', value: GAGE_TOLERANCE }).totalGageRR;
    }
    if (!preparedGage?.ok) return null;
    try {
      return computeGageRR(preparedGage.study.observations, resolveGageTolerance({ gageTolMode, gageTolValue, lsl, usl, lslOn, uslOn })).totalGageRR;
    } catch {
      return null; // 状态栏显示未运行；页面负责给出具体原因
    }
  }, [requestedRealGage, preparedGage, gageTolMode, gageTolValue, lsl, usl, lslOn, uslOn]);

  // 全局快捷键（菜单栏标注的 Ctrl+S/O/P/N;输入控件聚焦时不劫持）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      if (s.busyOverlay) { e.preventDefault(); return; } // 事务遮罩期间禁用全部快捷键
      const modifier = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const editingTarget = isEditingTarget(e.target);

      // 对话框是独立交互上下文：应用壳快捷键绝不能穿透到被遮住的工作表。
      // 文本编辑器内的撤销/重做仍交给浏览器，其余壳命令同时阻止浏览器默认动作。
      if (s.modal) {
        if (e.key === 'F1' || (modifier && APPLICATION_SHORTCUT_KEYS.has(key))) {
          if (!editingTarget || (key !== 'z' && key !== 'y')) e.preventDefault();
        }
        return;
      }
      if (e.key === 'F1') {
        e.preventDefault();
        s.openModal('help');
        return;
      }
      if (!modifier || editingTarget) return;
      const k = key;
      if (k === 's') {
        e.preventDefault();
        exportProject(__APP_VERSION__, s.projectName).then((dest) => {
          if (dest) s.showToast('项目已保存: ' + dest);
        }).catch((error) => s.showToast(`项目保存失败：${errText(error)}`));
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
        // fix2609n C2:与菜单同一入口；导出快照期间被替换闸门拒绝时提示原因，不抛未捕获异常
        runNewWorksheet(s.goTo, s.showToast);
      } else if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        s.showToast(undoRedoToast('undo', useData.getState().undoEdit()));
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        s.showToast(undoRedoToast('redo', useData.getState().redoEdit()));
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
  // fix2609k PLATFORM-07:页头规格与能力页/五种报告同源(specLimitText),紧公差不被 toFixed(2) 改写
  const specLabel = lslOn && uslOn
    ? `${specLimitText(lsl)}–${specLimitText(usl)}`
    : lslOn ? `LSL ${specLimitText(lsl)}` : uslOn ? `USL ${specLimitText(usl)}` : '未启用';
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
    // 716-R3:副标题跟随能力口径(而非 SPC 口径)——能力页显示 Cpk 时此处不得再写「待配置」;
    // 输入闸门(含 1000σ 量纲哨兵)拦截时与能力页/状态栏/首页卡一致显示未运行。
    capability: preparedCap.error
      ? '能力数据角色待配置'
      : cap
        ? `正态能力 · ${preparedCap.variableName} · 规格 ${specLabel}`
        : `正态能力 · ${preparedCap.variableName} · 未运行(输入校验未通过)`,
    gagerr: !requestedRealGage
      ? '演示研究 · 交叉设计 · ANOVA 法'
      : preparedGage?.ok
        ? `导入数据 · ${preparedGage.study.operatorLabels.length} 操作员 × ${preparedGage.study.partLabels.length} 部件 × ${preparedGage.study.repeats} 次`
        : `尚未运行 · ${preparedGage?.reason ?? '数据角色待配置'}`,
    aql: `GB/T 2828.1 · ${aqlLevel.startsWith('S-') ? '特殊' : '一般'}检验水平 ${aqlLevel} · AQL ${aqlAQL} · ${aqlRegime === 'per100' ? '每百单位不合格数' : '百分不合格品'}`,
  };
  const subtitle = dynSub[page] ?? cur.sub;

  const rowSpcDisplayed = !preparedSpc.error && preparedSpc.layout === 'rows'
    && preparedSpc.model?.hasSubgroups === true && preparedSpc.model.k === M.k;
  // ID/行 数据列已在 716-R3 删除(只剩行号槽),列计数不再 +1
  const wsCols = M.colNames.length + textCols.length + (rowSpcDisplayed ? 2 : 0) + (M.isDemo ? 3 : 0);
  const analysisPage = page !== 'dashboard' && page !== 'assistant' && page !== 'worksheet';

  return (
    // 蜂群 P2-08:固定 minWidth:1180 + overflow:hidden 只有桌面壳(Tauri 最小窗口)能保证,
    // Web/PWA、平板、高倍缩放、分屏下核心操作会大面积移出视口,只能靠横向平移。
    // 桌面壳保留原约束;Web 端改为允许横向滚动 + 由 CSS 断点折叠侧栏(见 index.css)。
    <div
      className="app-root"
      style={{
        display: 'flex', flexDirection: 'column', height: '100vh',
        background: '#eef0f3', fontSize: 13, overflow: 'hidden',
      }}
    >
      <MenuBar wsName={M.name} />
      <Toolbar />

      <div className="app-body" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <SideNav />
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#eef0f3' }}>
          <div className="page-header" style={{ display: 'flex', alignItems: 'center', padding: '14px 22px', background: '#fff', borderBottom: '1px solid #e0e4ea', flex: 'none' }}>
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

          <div className="page-content" style={{ flex: 1, overflowY: 'auto', padding: '20px 22px 40px' }}>
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

      <ErrorBoundary resetKey={modal ?? ''} fallback={(error, reset) => <ModalCrashCard error={error} reset={reset} />}>
        <Modals />
      </ErrorBoundary>
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
