/**
 * UI 全局状态（交接文档 §6）。派生数据一律由 /core 纯函数实时计算，不入 store。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NelsonRules, InspectionLevel, CalcState, AnovaMode, AqlMethod } from '../core';
import { calcKey as coreCalcKey, CALC_INIT } from '../core';

export type Page =
  | 'dashboard' | 'assistant' | 'worksheet' | 'summary' | 'spc' | 'capability' | 'gagerr'
  | 'anova' | 'pareto' | 'doe' | 'aql';
export type SpcType = 'xbar-r' | 'xbar-s' | 'i-mr' | 'ewma' | 'cusum' | 'p' | 'c';
export type Modal = 'import' | 'export' | 'calc' | 'formula' | 'subset' | 'vault' | 'findreplace' | 'about' | 'sort' | 'colstats' | 'random' | 'help' | 'options' | null;
export type ImportTab = 'csv' | 'excel' | 'clip' | 'mes';
export type ImportKind = 'var' | 'p' | 'c' | 'pareto';
export type ExportFmt = 'pdf' | 'excel' | 'ppt' | 'word';
export type DoeView = 'main' | 'interact' | 'pareto' | 'cube';
export type HypoTab = 'anova' | 't1' | 't2' | 'reg';
export type ParetoView = 'pareto' | 'fishbone';
export type ChartStyle = '经典' | '现代' | '高对比';

interface AppState {
  page: Page;
  spcType: SpcType;
  spcRules: NelsonRules;
  selSub: number | null;
  projectName: string;
  lsl: number;
  usl: number;
  tgt: number;
  lslOn: boolean; // 单侧规格开关（至少一侧开启）
  uslOn: boolean;
  doeView: DoeView;
  doeFactorCols: string[] | null; // DOE 分析选中的因子列名(null=默认前 k-1 列);按名存储,换数据集自动失效回落默认
  doeRespCol: string | null;      // DOE 分析选中的响应列名(null=默认末列)
  hypoTab: HypoTab;
  anovaMode: AnovaMode;            // ANOVA 分组形态:长表/宽表/数值因子(按名存,页面与汇总共用)
  anovaRespName: string | null;   // 数值响应列名(长表/数值因子模式)
  anovaFactorName: string | null; // 分组列名(长表=文本列;数值因子=数值列)
  paretoView: ParetoView;
  aqlLot: number;
  aqlLevel: InspectionLevel;
  aqlAQL: number;
  aqlMethod: AqlMethod; // 字码判定:'gb' 国标查表(默认) / 'shift' 位移近似
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
  setSelSub(i: number | null): void;
  setSpec(patch: Partial<Pick<AppState, 'lsl' | 'usl' | 'tgt'>>): void;
  setProjectName(name: string): void;
  toggleSide(side: 'lslOn' | 'uslOn'): void;
  setDoeView(v: DoeView): void;
  setDoeCols(factorCols: string[] | null, respCol: string | null): void;
  setHypoTab(v: HypoTab): void;
  setAnovaSel(patch: Partial<Pick<AppState, 'anovaMode' | 'anovaRespName' | 'anovaFactorName'>>): void;
  setParetoView(v: ParetoView): void;
  setAql(patch: Partial<Pick<AppState, 'aqlLot' | 'aqlLevel' | 'aqlAQL' | 'aqlMethod'>>): void;
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
  spcRules: { r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false },
  selSub: null,
  projectName: '质检项目 2026-Q2',
  lsl: 24.9,
  usl: 25.1,
  tgt: 25.0,
  lslOn: true,
  uslOn: true,
  doeView: 'main',
  doeFactorCols: null,
  doeRespCol: null,
  hypoTab: 'anova',
  anovaMode: 'stacked',
  anovaRespName: null,
  anovaFactorName: null,
  paretoView: 'pareto',
  aqlLot: 120,
  aqlLevel: 'II',
  aqlAQL: 1.0,
  aqlMethod: 'gb',
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
  setSelSub: (selSub) => set({ selSub }),
  setSpec: (patch) => set(patch),
  setProjectName: (projectName) => set({ projectName: projectName.trim() || '未命名项目' }),
  toggleSide: (side) => set((s) => {
    const next = { ...s, [side]: !s[side] };
    // 至少保留一侧
    if (!next.lslOn && !next.uslOn) return s;
    return { [side]: next[side] } as Partial<AppState>;
  }),
  setDoeView: (doeView) => set({ doeView }),
  setDoeCols: (doeFactorCols, doeRespCol) => set({ doeFactorCols, doeRespCol }),
  setHypoTab: (hypoTab) => set({ hypoTab }),
  setAnovaSel: (patch) => set(patch),
  setParetoView: (paretoView) => set({ paretoView }),
  setAql: (patch) => set(patch),
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
    aqlLot: s.aqlLot,
    aqlLevel: s.aqlLevel,
    aqlAQL: s.aqlAQL,
    aqlMethod: s.aqlMethod,
    spcRules: s.spcRules,
  }) as Partial<AppState>,
  version: 1,
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
    return p as Partial<AppState>;
  },
}));
