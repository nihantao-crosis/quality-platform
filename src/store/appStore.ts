/**
 * UI 全局状态（交接文档 §6）。派生数据一律由 /core 纯函数实时计算，不入 store。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NelsonRules, InspectionLevel, CalcState, AnovaMode, AqlMethod, AqlAcMethod, SwitchStatus, SpcDataLayout } from '../core';
import { calcKey as coreCalcKey, CALC_INIT, freshSwitchStatus, normalizeSwitchStatus } from '../core';

export type Page =
  | 'dashboard' | 'assistant' | 'worksheet' | 'summary' | 'spc' | 'capability' | 'gagerr'
  | 'anova' | 'pareto' | 'doe' | 'aql';
export type SpcType = 'xbar-r' | 'xbar-s' | 'i-mr' | 'ewma' | 'cusum' | 'p' | 'c';
export type Modal = 'import' | 'export' | 'calc' | 'formula' | 'subset' | 'vault' | 'findreplace' | 'about' | 'sort' | 'colstats' | 'random' | 'help' | 'options' | null;
export type ImportTab = 'csv' | 'excel' | 'clip' | 'mes';
export type ImportKind = 'var' | 'p' | 'c' | 'pareto';
export type ExportFmt = 'pdf' | 'excel' | 'ppt' | 'word';
export type DoeView = 'main' | 'interact' | 'pareto' | 'cube';
export type DoeTab = 'analyze' | 'create';
export type HypoTab = 'anova' | 't1' | 't2' | 'reg';
export type ParetoView = 'pareto' | 'fishbone';
export type ChartStyle = '经典' | '现代' | '高对比';

export const DEFAULT_SPC_RULES: NelsonRules = {
  r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false,
};

interface AppState {
  page: Page;
  spcType: SpcType;
  spcRules: NelsonRules;
  /** SPC 原始工作表到控制图矩阵的数据形态与角色；按列名保存，分析记录也会快照。 */
  spcDataLayout: SpcDataLayout;
  spcValueCol: string | null;
  spcSubgroupCol: string | null;
  /** X̄-R 分阶段列名；按名存储，避免文本列重排后指向错列 */
  spcStageCol: string | null;
  selSub: number | null;
  projectName: string;
  lsl: number;
  usl: number;
  tgt: number;
  lslOn: boolean; // 单侧规格开关（至少一侧开启）
  uslOn: boolean;
  capabilityBins: number;
  gageUseReal: boolean;
  gageValueName: string | null;
  gagePartName: string | null;
  gageOperatorName: string | null;
  doeView: DoeView;
  doeTab: DoeTab;
  doeFactorCols: string[] | null; // DOE 分析选中的因子列名(null=默认前 k-1 列);按名存储,换数据集自动失效回落默认
  doeRespCol: string | null;      // DOE 分析选中的响应列名(null=默认末列)
  doeModelTerms: string[] | null; // null=当前因子可用的全部效应项
  doeIncludeCurvature: boolean;
  hypoTab: HypoTab;
  anovaMode: AnovaMode;            // ANOVA 分组形态:长表/宽表/数值因子(按名存,页面与汇总共用)
  anovaRespName: string | null;   // 数值响应列名(长表/数值因子模式)
  anovaFactorName: string | null; // 分组列名(长表=文本列;数值因子=数值列)
  anovaShowDemo: boolean;       // 空态中用户明确选择的 ANOVA 示例
  t1ColName: string | null;
  t1Mu0: number | null;
  t2ColAName: string | null;
  t2ColBName: string | null;
  regXName: string | null;
  regYName: string | null;
  paretoView: ParetoView;
  paretoMergeOther: boolean;
  paretoThreshold: number; // 合并尾部累计阈值，0.5–1
  paretoShowDemo: boolean; // 空数据时是否明确查看内置示例（瞬态，但分析快照会记录）
  fishboneRevision: number; // 历史恢复后强制已挂载鱼骨组件重读本地快照
  aqlLot: number;
  aqlLevel: InspectionLevel;
  aqlAQL: number;
  aqlMethod: AqlMethod;     // 兼容旧快照；正式产品路径固定为 'gb'
  aqlAcMethod: AqlAcMethod; // 兼容旧快照；正式产品路径固定为 'gb'
  aqlSwitch: SwitchStatus;  // 当前正常/加严/放宽状态及批次历史
  openMenu: string | null;
  modal: Modal;
  toast: string | null;
  activeVar: string;
  varOpen: boolean;
  importTab: ImportTab;
  importKind: ImportKind;
  exportFmt: ExportFmt;
  chartStyle: ChartStyle;
  showGrid: boolean;
  calc: CalcState;

  goTo(page: Page): void;
  showToast(msg: string): void;
  openModal(m: Exclude<Modal, null>): void;
  closeModal(): void;
  setOpenMenu(m: string | null): void;
  setVarOpen(v: boolean): void;
  setActiveVar(v: string): void;
  setSpcType(t: SpcType): void;
  toggleRule(r: keyof NelsonRules): void;
  setSpcRoles(patch: Partial<Pick<AppState, 'spcDataLayout' | 'spcValueCol' | 'spcSubgroupCol'>>): void;
  setSpcStageCol(name: string | null): void;
  setSelSub(i: number | null): void;
  setSpec(patch: Partial<Pick<AppState, 'lsl' | 'usl' | 'tgt'>>): void;
  setProjectName(name: string): void;
  toggleSide(side: 'lslOn' | 'uslOn'): void;
  setCapabilityBins(v: number): void;
  setGageOptions(patch: Partial<Pick<AppState, 'gageUseReal' | 'gageValueName' | 'gagePartName' | 'gageOperatorName'>>): void;
  setDoeView(v: DoeView): void;
  setDoeTab(v: DoeTab): void;
  setDoeCols(factorCols: string[] | null, respCol: string | null): void;
  setDoeModel(patch: Partial<Pick<AppState, 'doeModelTerms' | 'doeIncludeCurvature'>>): void;
  setHypoTab(v: HypoTab): void;
  setAnovaSel(patch: Partial<Pick<AppState, 'anovaMode' | 'anovaRespName' | 'anovaFactorName'>>): void;
  setAnovaShowDemo(v: boolean): void;
  setHypothesisOptions(patch: Partial<Pick<AppState, 't1ColName' | 't1Mu0' | 't2ColAName' | 't2ColBName' | 'regXName' | 'regYName'>>): void;
  setParetoView(v: ParetoView): void;
  setParetoOptions(patch: Partial<Pick<AppState, 'paretoMergeOther' | 'paretoThreshold'>>): void;
  setParetoShowDemo(v: boolean): void;
  bumpFishboneRevision(): void;
  setAql(patch: Partial<Pick<AppState, 'aqlLot' | 'aqlLevel' | 'aqlAQL' | 'aqlMethod' | 'aqlAcMethod'>>): void;
  setAqlSwitch(status: SwitchStatus): void;
  setImportTab(t: ImportTab): void;
  setImportKind(k: ImportKind): void;
  setExportFmt(f: ExportFmt): void;
  setChartStyle(s: ChartStyle): void;
  cycleChartStyle(): void;
  toggleGrid(): void;
  pressCalc(k: string): void;
}

const STYLE_ORDER: ChartStyle[] = ['经典', '现代', '高对比'];

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useApp = create<AppState>()(persist((set, get) => ({
  page: 'dashboard',
  spcType: 'xbar-r',
  // 默认开启经典四则(1/2/3 + 5「2 of 3 越 2σ」);4/6/7/8 较敏感,默认关闭供按需开启
  spcRules: { ...DEFAULT_SPC_RULES },
  spcDataLayout: 'auto',
  spcValueCol: null,
  spcSubgroupCol: null,
  spcStageCol: null,
  selSub: null,
  projectName: '质检项目 2026-Q2',
  lsl: 24.9,
  usl: 25.1,
  tgt: 25.0,
  lslOn: true,
  uslOn: true,
  capabilityBins: 13,
  gageUseReal: true,
  gageValueName: null,
  gagePartName: null,
  gageOperatorName: null,
  doeView: 'main',
  doeTab: 'analyze',
  doeFactorCols: null,
  doeRespCol: null,
  doeModelTerms: null,
  doeIncludeCurvature: true,
  hypoTab: 'anova',
  anovaMode: 'stacked',
  anovaRespName: null,
  anovaFactorName: null,
  anovaShowDemo: false,
  t1ColName: null,
  t1Mu0: null,
  t2ColAName: null,
  t2ColBName: null,
  regXName: null,
  regYName: null,
  paretoView: 'pareto',
  paretoMergeOther: false,
  paretoThreshold: 0.95,
  paretoShowDemo: false,
  fishboneRevision: 0,
  aqlLot: 120,
  aqlLevel: 'II',
  aqlAQL: 1.0,
  aqlMethod: 'gb',
  aqlAcMethod: 'gb',
  aqlSwitch: freshSwitchStatus(),
  openMenu: null,
  modal: null,
  toast: null,
  activeVar: 'C2 直径 (mm)',
  varOpen: false,
  importTab: 'csv',
  importKind: 'var',
  exportFmt: 'pdf',
  chartStyle: '经典',
  showGrid: true,
  calc: CALC_INIT,

  goTo: (page) => set({ page, openMenu: null, varOpen: false }),
  showToast: (msg) => {
    clearTimeout(toastTimer);
    set({ toast: msg, openMenu: null, varOpen: false });
    toastTimer = setTimeout(() => set({ toast: null }), 2400);
  },
  openModal: (modal) => set({ modal, openMenu: null, varOpen: false }),
  closeModal: () => set({ modal: null }),
  setOpenMenu: (openMenu) => set({ openMenu, varOpen: false }),
  setVarOpen: (varOpen) => set({ varOpen, openMenu: null }),
  setActiveVar: (activeVar) => set({ activeVar, varOpen: false }),
  setSpcType: (spcType) => set({ spcType, selSub: null }),
  toggleRule: (r) => set((s) => ({ spcRules: { ...s.spcRules, [r]: !s.spcRules[r] } })),
  setSpcRoles: (patch) => set({ ...patch, selSub: null, spcStageCol: null }),
  setSpcStageCol: (spcStageCol) => set({ spcStageCol, selSub: null }),
  setSelSub: (selSub) => set({ selSub }),
  setSpec: (patch) => set(patch),
  setProjectName: (projectName) => set({ projectName: projectName.trim() || '未命名项目' }),
  toggleSide: (side) => set((s) => {
    const next = { ...s, [side]: !s[side] };
    // 至少保留一侧
    if (!next.lslOn && !next.uslOn) return s;
    return { [side]: next[side] } as Partial<AppState>;
  }),
  setCapabilityBins: (value) => set({ capabilityBins: Math.max(5, Math.min(40, Math.round(value))) }),
  setGageOptions: (patch) => set(patch),
  setDoeView: (doeView) => set({ doeView }),
  setDoeTab: (doeTab) => set({ doeTab }),
  setDoeCols: (doeFactorCols, doeRespCol) => set({ doeFactorCols, doeRespCol, doeModelTerms: null }),
  setDoeModel: (patch) => set(patch),
  setHypoTab: (hypoTab) => set({ hypoTab }),
  setAnovaSel: (patch) => set(patch),
  setAnovaShowDemo: (anovaShowDemo) => set({ anovaShowDemo }),
  setHypothesisOptions: (patch) => set(patch),
  setParetoView: (paretoView) => set({ paretoView }),
  setParetoOptions: (patch) => set((s) => {
    const raw = patch.paretoThreshold;
    const paretoThreshold = raw == null || !Number.isFinite(raw)
      ? s.paretoThreshold
      : Math.max(0.5, Math.min(1, raw));
    return { ...patch, paretoThreshold };
  }),
  setParetoShowDemo: (paretoShowDemo) => set({ paretoShowDemo }),
  bumpFishboneRevision: () => set((state) => ({ fishboneRevision: state.fishboneRevision + 1 })),
  setAql: (patch) => set((s) => {
    // GB/T 2828.1 / ISO 2859-1 的检验状态在连续批间延续；批量本来就可以逐批变化。
    // 只有检验水平/AQL/方法改变才代表换了检验体系、需要重建转移序列；
    // 单独改下一批 N 只重新查本批方案，不得把加严/放宽状态和转移得分清零。
    const sequenceKeys: Array<keyof Pick<AppState, 'aqlLevel' | 'aqlAQL' | 'aqlMethod' | 'aqlAcMethod'>> = [
      'aqlLevel', 'aqlAQL', 'aqlMethod', 'aqlAcMethod',
    ];
    const sequenceChanged = sequenceKeys.some((key) => key in patch && patch[key] !== s[key]);
    const previous = normalizeSwitchStatus(s.aqlSwitch);
    const reset = freshSwitchStatus();
    return {
      ...patch,
      // 转移历史只对生成它的检验体系有效；换水平/AQL/方法后重新开始。
      // 已归档的批次责任追溯不得随方案参数变更丢失。
      ...(sequenceChanged ? { aqlSwitch: { ...reset, records: previous.records.map((record) => ({ ...record })) } } : {}),
    };
  }),
  setAqlSwitch: (aqlSwitch) => set({ aqlSwitch: normalizeSwitchStatus(aqlSwitch) }),
  setImportTab: (importTab) => set({ importTab }),
  setImportKind: (importKind) => set({ importKind }),
  setExportFmt: (exportFmt) => set({ exportFmt }),
  setChartStyle: (chartStyle) => set({ chartStyle, openMenu: null }),
  cycleChartStyle: () =>
    set((s) => ({ chartStyle: STYLE_ORDER[(STYLE_ORDER.indexOf(s.chartStyle) + 1) % STYLE_ORDER.length] })),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid, openMenu: null })),
  pressCalc: (k) => set({ calc: coreCalcKey(get().calc, k) }),
}), {
  name: 'qp-prefs-v1',
  // 仅持久化用户偏好；导航/弹窗等瞬态不落盘
  partialize: (s) => ({
    chartStyle: s.chartStyle,
    showGrid: s.showGrid,
    projectName: s.projectName,
    lsl: s.lsl,
    usl: s.usl,
    tgt: s.tgt,
    lslOn: s.lslOn,
    uslOn: s.uslOn,
    capabilityBins: s.capabilityBins,
    gageUseReal: s.gageUseReal,
    gageValueName: s.gageValueName,
    gagePartName: s.gagePartName,
    gageOperatorName: s.gageOperatorName,
    aqlLot: s.aqlLot,
    aqlLevel: s.aqlLevel,
    aqlAQL: s.aqlAQL,
    aqlMethod: s.aqlMethod,
    aqlAcMethod: s.aqlAcMethod,
    aqlSwitch: s.aqlSwitch,
    spcRules: s.spcRules,
    spcDataLayout: s.spcDataLayout,
    spcValueCol: s.spcValueCol,
    spcSubgroupCol: s.spcSubgroupCol,
    spcStageCol: s.spcStageCol,
    doeView: s.doeView,
    doeTab: s.doeTab,
    doeFactorCols: s.doeFactorCols,
    doeRespCol: s.doeRespCol,
    doeModelTerms: s.doeModelTerms,
    doeIncludeCurvature: s.doeIncludeCurvature,
    t1ColName: s.t1ColName,
    t1Mu0: s.t1Mu0,
    t2ColAName: s.t2ColAName,
    t2ColBName: s.t2ColBName,
    regXName: s.regXName,
    regYName: s.regYName,
    paretoView: s.paretoView,
    paretoMergeOther: s.paretoMergeOther,
    paretoThreshold: s.paretoThreshold,
  }) as Partial<AppState>,
  version: 2,
  // v0→v1:判异准则从 4 条扩为 8 条,旧「准则4(2 of 3 越 2σ)」实为标准检验 5,迁移到 r5;
  // 补齐缺失的 r4/r6/r7/r8(默认关),避免旧偏好把 r4 误当"14 点交替"。
  migrate: (persisted: unknown, version: number) => {
    const p = { ...(persisted as Record<string, unknown> | null ?? {}) };
    if (version < 1 && p.spcRules) {
      const old = p.spcRules as Record<string, boolean>;
      p.spcRules = {
        r1: old.r1 ?? true, r2: old.r2 ?? true, r3: old.r3 ?? true,
        r4: false, r5: old.r4 ?? true, r6: false, r7: false, r8: false,
      } satisfies NelsonRules;
    }
    // v2：AQL 产品路径改为 GB/T 2828.1 正式表 2-A/2-B/2-C 与正式转移得分。
    // 旧近似偏好不能继续潜伏在持久化状态中；旧四字段转移状态补齐新字段。
    if (version < 2) {
      p.aqlMethod = 'gb';
      p.aqlAcMethod = 'gb';
      p.aqlSwitch = normalizeSwitchStatus(p.aqlSwitch as Partial<SwitchStatus> | undefined);
    }
    return p as Partial<AppState>;
  },
}));
