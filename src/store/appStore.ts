/**
 * UI 全局状态（交接文档 §6）。派生数据一律由 /core 纯函数实时计算，不入 store。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NelsonRules, InspectionLevel, CalcState } from '../core';
import { calcKey as coreCalcKey, CALC_INIT } from '../core';

export type Page =
  | 'dashboard' | 'worksheet' | 'spc' | 'capability' | 'gagerr'
  | 'anova' | 'pareto' | 'doe' | 'aql';
export type SpcType = 'xbar-r' | 'xbar-s' | 'i-mr' | 'ewma' | 'cusum' | 'p' | 'c';
export type Modal = 'import' | 'export' | 'calc' | 'about' | 'sort' | 'colstats' | 'random' | null;
export type ImportTab = 'csv' | 'excel' | 'clip' | 'mes';
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
  lsl: number;
  usl: number;
  tgt: number;
  lslOn: boolean; // 单侧规格开关（至少一侧开启）
  uslOn: boolean;
  doeView: DoeView;
  hypoTab: HypoTab;
  paretoView: ParetoView;
  aqlLot: number;
  aqlLevel: InspectionLevel;
  aqlAQL: number;
  openMenu: string | null;
  modal: Modal;
  toast: string | null;
  activeVar: string;
  varOpen: boolean;
  importTab: ImportTab;
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
  toggleSide(side: 'lslOn' | 'uslOn'): void;
  setDoeView(v: DoeView): void;
  setHypoTab(v: HypoTab): void;
  setParetoView(v: ParetoView): void;
  setAql(patch: Partial<Pick<AppState, 'aqlLot' | 'aqlLevel' | 'aqlAQL'>>): void;
  setImportTab(t: ImportTab): void;
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
  spcRules: { r1: true, r2: true, r3: true, r4: true },
  selSub: null,
  lsl: 24.9,
  usl: 25.1,
  tgt: 25.0,
  lslOn: true,
  uslOn: true,
  doeView: 'main',
  hypoTab: 'anova',
  paretoView: 'pareto',
  aqlLot: 120,
  aqlLevel: 'II',
  aqlAQL: 1.0,
  openMenu: null,
  modal: null,
  toast: null,
  activeVar: 'C2 直径 (mm)',
  varOpen: false,
  importTab: 'csv',
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
  toggleSide: (side) => set((s) => {
    const next = { ...s, [side]: !s[side] };
    // 至少保留一侧
    if (!next.lslOn && !next.uslOn) return s;
    return { [side]: next[side] } as Partial<AppState>;
  }),
  setDoeView: (doeView) => set({ doeView }),
  setHypoTab: (hypoTab) => set({ hypoTab }),
  setParetoView: (paretoView) => set({ paretoView }),
  setAql: (patch) => set(patch),
  setImportTab: (importTab) => set({ importTab }),
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
    lsl: s.lsl,
    usl: s.usl,
    tgt: s.tgt,
    lslOn: s.lslOn,
    uslOn: s.uslOn,
    aqlLot: s.aqlLot,
    aqlLevel: s.aqlLevel,
    aqlAQL: s.aqlAQL,
    spcRules: s.spcRules,
  }) as Partial<AppState>,
}));
