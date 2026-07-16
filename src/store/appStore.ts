/**
 * UI 全局状态（交接文档 §6）。派生数据一律由 /core 纯函数实时计算，不入 store。
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { NelsonRules, NelsonRuleK, InspectionLevel, CalcState, AnovaMode, AqlMethod, AqlAcMethod, SwitchStatus, SpcDataLayout } from '../core';
import {
  AQL_COLS, MAX_LOT_SIZE, calcKey as coreCalcKey, CALC_INIT,
  freshSwitchStatus, normalizeSwitchStatus, DEFAULT_RULE_K, normalizeRuleK,
} from '../core';
import { projectStoreValidationError, registerProjectLifecycleHooks } from '../platform/project';
import { preserveCorruptStore } from './quarantine';

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

let aqlSequenceCounter = 0;
const nextAqlSequenceId = () => {
  aqlSequenceCounter += 1;
  return `aql-${Date.now().toString(36)}-${aqlSequenceCounter.toString(36)}`;
};

interface AppState {
  page: Page;
  spcType: SpcType;
  spcRules: NelsonRules;
  /** 判异准则可编辑 K 值(Minitab Xbar-R 选项→检验);始终经 normalizeRuleK 约束。 */
  spcRuleK: NelsonRuleK;
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
  /** 能力分析子组口径(批次716-N):沿用SPC角色 / 单列+常量子组 / 单列+子组ID列。 */
  capSubgroupMode: 'spc' | 'const' | 'stacked';
  capSubgroupSize: number;
  capValueCol: string | null;
  capSubgroupIdCol: string | null;
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
  /** P0-3:全屏事务遮罩(项目导入等不可打断操作);非空时 UI 应拒绝一切交互。 */
  busyOverlay: string | null;
  setBusyOverlay(msg: string | null): void;
  openModal(m: Exclude<Modal, null>): void;
  closeModal(): void;
  setOpenMenu(m: string | null): void;
  setVarOpen(v: boolean): void;
  setActiveVar(v: string): void;
  setSpcType(t: SpcType): void;
  toggleRule(r: keyof NelsonRules): void;
  setSpcRuleK(patch: Partial<NelsonRuleK>): void;
  setSpcRoles(patch: Partial<Pick<AppState, 'spcDataLayout' | 'spcValueCol' | 'spcSubgroupCol'>>): void;
  setSpcStageCol(name: string | null): void;
  setSelSub(i: number | null): void;
  setSpec(patch: Partial<Pick<AppState, 'lsl' | 'usl' | 'tgt'>>): void;
  setProjectName(name: string): void;
  toggleSide(side: 'lslOn' | 'uslOn'): void;
  setCapabilityBins(v: number): void;
  setCapabilitySubgroup(patch: Partial<Pick<AppState, 'capSubgroupMode' | 'capSubgroupSize' | 'capValueCol' | 'capSubgroupIdCol'>>): void;
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

let prefsPersistenceDirty = false;
let prefsStorageWarned = false;
let prefsPersistenceSuspended = false;
let protectedCorruptPrefs: { raw: string; detail: string } | null = null;

/**
 * Zustand 的 merge 会按 partialize 白名单逐字段校验；因此只有 envelope/state
 * 结构本身损坏时才无法恢复。字段类型错误或额外键仍保留原文到隔离区，
 * 但应让 merge 提取其中合法的偏好，避免一个坏字段清空整份设置。
 */
function isRecoverablePrefsEnvelope(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const envelope = raw as { state?: unknown; version?: unknown };
  if (!envelope.state || typeof envelope.state !== 'object' || Array.isArray(envelope.state)) return false;
  return envelope.version === undefined
    || (Number.isSafeInteger(envelope.version) && (envelope.version as number) >= 0
      && (envelope.version as number) <= 3);
}

const safePrefsStorage = {
  getItem(name: string): string | null {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(name);
      if (raw == null) return null;
      const parsed = JSON.parse(raw) as unknown;
      const detail = projectStoreValidationError(name, parsed);
      if (!detail) return raw;
      if (!preserveCorruptStore(name, raw, detail)) protectedCorruptPrefs = { raw, detail };
      else protectedCorruptPrefs = null;
      // 语义污染交给下方白名单 merge 逐字段回退；结构损坏才整体拒绝。
      return isRecoverablePrefsEnvelope(parsed) ? raw : null;
    } catch {
      if (raw && !preserveCorruptStore(name, raw, 'JSON 解析失败或写入被截断')) {
        protectedCorruptPrefs = { raw, detail: 'JSON 解析失败或写入被截断' };
      } else if (raw) protectedCorruptPrefs = null;
      return null;
    }
  },
  setItem(name: string, value: string): void {
    if (prefsPersistenceSuspended) return;
    if (protectedCorruptPrefs) {
      let live: string | null = protectedCorruptPrefs.raw;
      try { live = localStorage.getItem(name); } catch { /* 使用已捕获原文重试 */ }
      if (live == null) protectedCorruptPrefs = null;
      else if (!preserveCorruptStore(name, live, protectedCorruptPrefs.detail)) {
        prefsPersistenceDirty = true;
        return;
      } else protectedCorruptPrefs = null;
    }
    try {
      localStorage.setItem(name, value);
      prefsPersistenceDirty = false;
      prefsStorageWarned = false;
    } catch {
      prefsPersistenceDirty = true;
      // Zustand 已先更新内存；持久层异常不能再从 React 事件冒泡造成“半成功”。
      if (!prefsStorageWarned) {
        prefsStorageWarned = true;
        queueMicrotask(() => {
          try { useApp.getState().showToast('界面与分析参数尚未写入本地存储；项目导出将使用当前内存中的最新值'); }
          catch { /* store 初始化期间忽略 */ }
        });
      }
    }
  },
  removeItem(name: string): void {
    if (prefsPersistenceSuspended) return;
    try {
      localStorage.removeItem(name);
      prefsPersistenceDirty = false;
    } catch {
      prefsPersistenceDirty = true;
    }
  },
};

function persistedPrefsOf(s: AppState) {
  return {
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
    spcRules: s.spcRules,
    spcRuleK: s.spcRuleK,
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
  };
}

export const AQL_STATE_STORAGE_KEY = 'qp-aql-state-v1';

interface PersistedAqlState {
  aqlLot: number;
  aqlLevel: InspectionLevel;
  aqlAQL: number;
  aqlMethod: 'gb';
  aqlAcMethod: 'gb';
  aqlSwitch: SwitchStatus;
}

let aqlStateCorrupt = false;
let aqlStateQuarantined = false;

function loadPersistedAqlState(): PersistedAqlState | null {
  let text: string | null = null;
  try {
    text = localStorage.getItem(AQL_STATE_STORAGE_KEY);
    if (!text) return null;
    const raw = JSON.parse(text) as PersistedAqlState;
    const detail = projectStoreValidationError(AQL_STATE_STORAGE_KEY, raw);
    if (detail) {
      aqlStateCorrupt = true;
      // P1-4:声明「已隔离」前必须真的把原文复制进隔离区;失败则如实说明。
      aqlStateQuarantined = preserveCorruptStore(AQL_STATE_STORAGE_KEY, text, detail);
      return null;
    }
    return {
      aqlLot: raw.aqlLot, aqlLevel: raw.aqlLevel, aqlAQL: raw.aqlAQL,
      aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: normalizeSwitchStatus(raw.aqlSwitch),
    };
  } catch {
    aqlStateCorrupt = true;
    if (text != null) aqlStateQuarantined = preserveCorruptStore(AQL_STATE_STORAGE_KEY, text, 'JSON 解析失败或写入被截断');
    return null;
  }
}

const initialAql = loadPersistedAqlState();

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useApp = create<AppState>()(persist((set, get) => ({
  page: 'dashboard',
  spcType: 'xbar-r',
  // 默认开启经典四则(1/2/3 + 5「2 of 3 越 2σ」);4/6/7/8 较敏感,默认关闭供按需开启
  spcRules: { ...DEFAULT_SPC_RULES },
  spcRuleK: { ...DEFAULT_RULE_K },
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
  capSubgroupMode: 'spc',
  capSubgroupSize: 5,
  capValueCol: null,
  capSubgroupIdCol: null,
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
  aqlLot: initialAql?.aqlLot ?? 120,
  aqlLevel: initialAql?.aqlLevel ?? 'II',
  aqlAQL: initialAql?.aqlAQL ?? 1.0,
  aqlMethod: 'gb',
  aqlAcMethod: 'gb',
  aqlSwitch: initialAql?.aqlSwitch ?? freshSwitchStatus(),
  openMenu: null,
  modal: null,
  toast: null,
  // 保存真实列名；工具栏按当前工作表动态生成候选，不能残留演示列号。
  activeVar: '',
  varOpen: false,
  importTab: 'csv',
  importKind: 'var',
  exportFmt: 'pdf',
  chartStyle: '经典',
  showGrid: true,
  calc: CALC_INIT,

  goTo: (page) => set({ page, openMenu: null, varOpen: false }),
  busyOverlay: null,
  setBusyOverlay: (msg) => set({ busyOverlay: msg }),
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
  // 越界/非法字段由 normalizeRuleK 回落标准值;UI 依据回写后的 store 值回弹输入框
  setSpcRuleK: (patch) => set((s) => ({ spcRuleK: normalizeRuleK({ ...s.spcRuleK, ...patch }) })),
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
  setCapabilitySubgroup: (patch) => set(patch),
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
    if (sequenceChanged && previous.state !== 'normal') {
      throw new Error(previous.suspended
        ? '抽样检验已暂停；确认纠正措施有效并恢复加严检验前，不能更改 AQL 或检验水平'
        : `当前处于${previous.state === 'tightened' ? '加严' : '放宽'}检验；须先按正式转移规则恢复正常检验后再更改 AQL 或检验水平`);
    }
    const reset = freshSwitchStatus();
    return {
      ...patch,
      // 转移历史只对生成它的检验体系有效；换水平/AQL/方法后重新开始。
      // 已归档的批次责任追溯不得随方案参数变更丢失。
      ...(sequenceChanged ? {
        aqlSwitch: {
          ...reset,
          sequenceId: nextAqlSequenceId(),
          records: previous.records.map((record) => ({ ...record })),
          note: '检验水平/AQL 已变更；已建立新的正常检验序列，转移得分从 0 开始',
        },
      } : {}),
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
  storage: createJSONStorage(() => safePrefsStorage),
  // 仅持久化用户偏好；导航/弹窗等瞬态不落盘
  partialize: (s) => persistedPrefsOf(s) as Partial<AppState>,
  version: 3,
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
    // v3：AQL 状态加入检验体系序列号和严格记录校验；旧责任记录迁入 legacy 序列。
    if (version < 3) {
      p.aqlSwitch = normalizeSwitchStatus(p.aqlSwitch as Partial<SwitchStatus> | undefined);
    }
    return p as Partial<AppState>;
  },
  // migrate 只在版本号变化时运行；merge 确保当前版本 localStorage/.qproj 也逐次校验。
  merge: (persisted: unknown, current) => {
    const p = persisted && typeof persisted === 'object' && !Array.isArray(persisted)
      ? persisted as Partial<AppState>
      : {};
    // 从干净的当前状态开始，仅在下方逐字段复制 partialize 白名单。
    // 不能先展开 p：同版本 localStorage/.qproj 可携带 page/modal/calc 或任意额外键，
    // 即使动作函数被回填，毒化的瞬态枚举仍会让应用进入不可渲染状态。
    const merged = { ...current } as AppState;
    const stringOrNull = (value: unknown, fallback: string | null) =>
      value === null || typeof value === 'string' ? value as string | null : fallback;
    const stringArrayOrNull = (value: unknown, fallback: string[] | null) =>
      value === null || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
        ? value as string[] | null
        : fallback;
    const finiteOr = (value: unknown, fallback: number) =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    merged.chartStyle = STYLE_ORDER.includes(p.chartStyle as ChartStyle) ? p.chartStyle as ChartStyle : current.chartStyle;
    merged.showGrid = typeof p.showGrid === 'boolean' ? p.showGrid : current.showGrid;
    merged.projectName = typeof p.projectName === 'string' && p.projectName.trim() ? p.projectName : current.projectName;
    merged.lsl = finiteOr(p.lsl, current.lsl);
    merged.usl = finiteOr(p.usl, current.usl);
    merged.tgt = finiteOr(p.tgt, current.tgt);
    const lslOn = typeof p.lslOn === 'boolean' ? p.lslOn : current.lslOn;
    const uslOn = typeof p.uslOn === 'boolean' ? p.uslOn : current.uslOn;
    merged.lslOn = !lslOn && !uslOn ? current.lslOn : lslOn;
    merged.uslOn = !lslOn && !uslOn ? current.uslOn : uslOn;
    merged.capabilityBins = Number.isSafeInteger(p.capabilityBins) && p.capabilityBins! >= 5 && p.capabilityBins! <= 40
      ? p.capabilityBins!
      : current.capabilityBins;
    merged.gageUseReal = typeof p.gageUseReal === 'boolean' ? p.gageUseReal : current.gageUseReal;
    merged.gageValueName = stringOrNull(p.gageValueName, current.gageValueName);
    merged.gagePartName = stringOrNull(p.gagePartName, current.gagePartName);
    merged.gageOperatorName = stringOrNull(p.gageOperatorName, current.gageOperatorName);
    const rules = p.spcRules && typeof p.spcRules === 'object' && !Array.isArray(p.spcRules)
      ? p.spcRules as Partial<NelsonRules>
      : {};
    merged.spcRules = Object.fromEntries((Object.keys(DEFAULT_SPC_RULES) as Array<keyof NelsonRules>).map((key) => [
      key, typeof rules[key] === 'boolean' ? rules[key] : current.spcRules[key],
    ])) as unknown as NelsonRules;
    // 逐字段规范化:任一 K 越界/非法即回落标准值,不拒绝整份偏好
    merged.spcRuleK = p.spcRuleK === undefined ? current.spcRuleK : normalizeRuleK(p.spcRuleK);
    merged.spcDataLayout = ['auto', 'rows', 'stacked', 'columns', 'individuals'].includes(p.spcDataLayout as string)
      ? p.spcDataLayout as SpcDataLayout
      : current.spcDataLayout;
    merged.spcValueCol = stringOrNull(p.spcValueCol, current.spcValueCol);
    merged.spcSubgroupCol = stringOrNull(p.spcSubgroupCol, current.spcSubgroupCol);
    merged.spcStageCol = stringOrNull(p.spcStageCol, current.spcStageCol);
    merged.doeView = ['main', 'interact', 'pareto', 'cube'].includes(p.doeView as string) ? p.doeView as DoeView : current.doeView;
    merged.doeTab = p.doeTab === 'analyze' || p.doeTab === 'create' ? p.doeTab : current.doeTab;
    merged.doeFactorCols = stringArrayOrNull(p.doeFactorCols, current.doeFactorCols);
    merged.doeRespCol = stringOrNull(p.doeRespCol, current.doeRespCol);
    merged.doeModelTerms = stringArrayOrNull(p.doeModelTerms, current.doeModelTerms);
    merged.doeIncludeCurvature = typeof p.doeIncludeCurvature === 'boolean' ? p.doeIncludeCurvature : current.doeIncludeCurvature;
    merged.t1ColName = stringOrNull(p.t1ColName, current.t1ColName);
    merged.t1Mu0 = p.t1Mu0 === null || (typeof p.t1Mu0 === 'number' && Number.isFinite(p.t1Mu0)) ? p.t1Mu0 : current.t1Mu0;
    merged.t2ColAName = stringOrNull(p.t2ColAName, current.t2ColAName);
    merged.t2ColBName = stringOrNull(p.t2ColBName, current.t2ColBName);
    merged.regXName = stringOrNull(p.regXName, current.regXName);
    merged.regYName = stringOrNull(p.regYName, current.regYName);
    merged.paretoView = p.paretoView === 'pareto' || p.paretoView === 'fishbone' ? p.paretoView : current.paretoView;
    merged.paretoMergeOther = typeof p.paretoMergeOther === 'boolean' ? p.paretoMergeOther : current.paretoMergeOther;
    merged.paretoThreshold = typeof p.paretoThreshold === 'number' && Number.isFinite(p.paretoThreshold)
      && p.paretoThreshold >= 0.5 && p.paretoThreshold <= 1 ? p.paretoThreshold : current.paretoThreshold;
    const separateAql = loadPersistedAqlState();
    // 独立账本一旦损坏就保留原文等待导入备份/显式清除，绝不能退回旧 prefs 后覆写坏证据。
    const aql = aqlStateCorrupt ? current : separateAql ?? p;
    merged.aqlLot = Number.isSafeInteger(aql.aqlLot) && aql.aqlLot! >= 2 && aql.aqlLot! <= MAX_LOT_SIZE
      ? aql.aqlLot!
      : current.aqlLot;
    merged.aqlLevel = aql.aqlLevel === 'I' || aql.aqlLevel === 'II' || aql.aqlLevel === 'III'
      ? aql.aqlLevel
      : current.aqlLevel;
    merged.aqlAQL = typeof aql.aqlAQL === 'number' && AQL_COLS.includes(aql.aqlAQL)
      ? aql.aqlAQL
      : current.aqlAQL;
    merged.aqlMethod = 'gb';
    merged.aqlAcMethod = 'gb';
    merged.aqlSwitch = normalizeSwitchStatus(aql.aqlSwitch ?? current.aqlSwitch);
    return merged;
  },
}));

function persistedAqlOf(state: AppState): PersistedAqlState {
  return {
    aqlLot: state.aqlLot, aqlLevel: state.aqlLevel, aqlAQL: state.aqlAQL,
    aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: normalizeSwitchStatus(state.aqlSwitch),
  };
}

let aqlPersistenceDirty = false;

function savePersistedAqlState(state: AppState): boolean {
  if (aqlStateCorrupt) {
    aqlPersistenceDirty = true;
    return false;
  }
  try {
    localStorage.setItem(AQL_STATE_STORAGE_KEY, JSON.stringify(persistedAqlOf(state)));
    aqlPersistenceDirty = false;
    return true;
  } catch {
    // 内存中的连续检验流继续可用，但导出/导入前必须重试并 fail-closed，不能静默导出旧账本。
    aqlPersistenceDirty = true;
    return false;
  }
}

useApp.subscribe((state, previous) => {
  if (state.aqlLot !== previous.aqlLot || state.aqlLevel !== previous.aqlLevel
    || state.aqlAQL !== previous.aqlAQL || state.aqlSwitch !== previous.aqlSwitch) {
    const wasDirty = aqlPersistenceDirty;
    if (!savePersistedAqlState(state) && !wasDirty) {
      state.showToast('AQL 责任账本尚未写入本地存储；请释放空间，项目导出会在安全落盘前阻止');
    }
  }
});

// 首次加载即把旧 qp-prefs-v1 中的 AQL 业务状态迁出；损坏的新账本必须原样保留以便恢复。
if (!aqlStateCorrupt) savePersistedAqlState(useApp.getState());
else useApp.getState().showToast(aqlStateQuarantined
  ? '检测到损坏的 AQL 责任账本，原文已复制到隔离区且未被覆盖；请导入有效项目备份或清除业务数据'
  : '检测到损坏的 AQL 责任账本（隔离区写入失败，原文仍保留在原位置、未被覆盖）；请勿清除浏览器数据，可通过导入有效项目备份恢复');

function requirePersistedAqlState(): void {
  if (aqlStateCorrupt) {
    throw new Error(aqlStateQuarantined
      ? 'AQL 责任账本已损坏（原文已复制到隔离区）；请先导入有效项目备份或清除业务数据'
      : 'AQL 责任账本已损坏（隔离区写入失败，原文仍保留在原位置）；请先导入有效项目备份或清除业务数据');
  }
  if (!savePersistedAqlState(useApp.getState())) {
    throw new Error('AQL 责任账本无法写入本地存储；请释放空间后重试');
  }
}

registerProjectLifecycleHooks({
  // 导入有效项目是损坏账本的恢复路径；仅普通写入失败时要求先落稳当前内存账本。
  beforeMutation: () => {
    if (prefsPersistenceDirty) {
      throw new Error('当前界面/分析参数尚未写入本地存储；请先导出项目或释放空间后再导入其他项目');
    }
    if (!aqlStateCorrupt) requirePersistedAqlState();
  },
  beforeExport: () => {
    if (protectedCorruptPrefs) throw new Error('损坏的偏好设置尚未成功复制到隔离区，项目未导出');
    if (aqlStateCorrupt) requirePersistedAqlState();
    // 配额不足时允许下面以内存覆盖项导出最新账本；不能退回 localStorage 中的旧值。
    savePersistedAqlState(useApp.getState());
  },
  projectStoreOverrides: () => ({
    'qp-prefs-v1': JSON.stringify({ state: persistedPrefsOf(useApp.getState()), version: 3 }),
    [AQL_STATE_STORAGE_KEY]: JSON.stringify(persistedAqlOf(useApp.getState())),
  }),
  afterSuccessfulMutation: () => {
    // applyProjectText 已写入新项目；刷新前任何 toast/modal set 都不能把旧内存偏好写回去。
    prefsPersistenceSuspended = true;
  },
});

export function resetUiPreferences(): void {
  useApp.setState({
    chartStyle: '经典', showGrid: true, projectName: '质检项目 2026-Q2',
    lsl: 24.9, usl: 25.1, tgt: 25, lslOn: true, uslOn: true, capabilityBins: 13,
    gageUseReal: true, gageValueName: null, gagePartName: null, gageOperatorName: null,
    spcRules: { ...DEFAULT_SPC_RULES }, spcRuleK: { ...DEFAULT_RULE_K },
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    doeView: 'main', doeTab: 'analyze', doeFactorCols: null, doeRespCol: null, doeModelTerms: null, doeIncludeCurvature: true,
    t1ColName: null, t1Mu0: null, t2ColAName: null, t2ColBName: null, regXName: null, regYName: null,
    paretoView: 'pareto', paretoMergeOther: false, paretoThreshold: 0.95,
  });
}

/** 清业务数据时立即清空内存中的连续检验流，并确保随后普通 UI set 不会把旧账本写回来。 */
export function clearAqlBusinessState(): void {
  aqlStateCorrupt = false;
  aqlPersistenceDirty = false;
  useApp.setState({
    aqlLot: 120, aqlLevel: 'II', aqlAQL: 1, aqlMethod: 'gb', aqlAcMethod: 'gb',
    aqlSwitch: freshSwitchStatus(),
  });
  // setState 的订阅会先写入干净空账本；“清业务数据”契约要求最终连该键一起移除。
  try { localStorage.removeItem(AQL_STATE_STORAGE_KEY); } catch { /* 忽略 */ }
}
