/**
 * 分析记录 — Minitab 式「项目工作台」骨架。
 * 每次「保存到项目」把当前分析连同其参数与所属数据集存为一条对象,
 * 可在仪表盘 / 项目管理器回看(切回数据集 + 还原参数 + 跳页),可删除,纳入 .qproj 备份。
 */
import { create } from 'zustand';
import {
  nf, capabilityInputError, computeCapability, evalRules, evalLimitedRules, prepareSpcData, computeGageRR, gageStudyData, GAGE_TOLERANCE,
  andersonDarling, assessCapability, countCapabilityViolations,
  prepareGageStudy, resolveNumericColumn,
  oneWayAnova, oneSampleT, twoSampleT, linearRegression, anovaGroups, buildAnovaGroups, wideScaleDisparate, resolveAnovaMode, countAnovaPendingCells, isDoeAnalysisColumn, analyzeDoe, detectFactorial, analyzeFactorial, factorialModelTerms, resolveDoeColumns, resolveDoeBlockValues, plansByState, computeDescriptive,
  ewmaSeries, cusumSeries, stagedXbar, stagedRange, stageValidationError, normalizeSwitchStatus,
  DEFAULT_RULE_K, normalizeRuleK,
  type InspectionLevel, type AnovaMode, type AqlMethod, type AqlAcMethod, type NelsonRules, type NelsonRuleK, type SwitchStatus, type SpcDataLayout,
} from '../core';
import { useApp, DEFAULT_SPC_RULES, type SpcType, type DoeView, type DoeTab, type HypoTab, type ParetoView } from './appStore';
import { syncSpecForActiveMeasurement, useData, resolveCapabilityMeasurementData, type ParetoModel } from './dataStore';
import { loadFishboneState, saveFishboneState, type FishboneData } from './fishboneStore';
import { sessionLog } from './sessionLog';
import { projectStoreValidationError, registerProjectLifecycleHooks } from '../platform/project';
import { preserveCorruptStore } from './quarantine';

export type AnalysisKind = 'spc' | 'capability' | 'gagerr' | 'anova' | 'pareto' | 'doe' | 'aql' | 'summary';

export interface AnalysisSourceData {
  name: string;
  colNames: string[];
  rows: number[][];
  textCols: { name: string; values: string[] }[];
  pendingCells?: { row: number; col: number }[];
  isDemo?: boolean;
  /** 演示原型等场景的 I-MR 序列可能不同于行优先展平值，需一并保存。 */
  indivSeries?: number[];
}

export interface AnalysisSnapshot {
  snapshotVersion?: 2 | 3 | 4 | 5;
  spcType?: SpcType;
  spcRules?: NelsonRules;
  /** 判异准则可编辑 K 值;缺失即当时的 Nelson/Minitab 标准值(旧记录兼容)。 */
  spcRuleK?: NelsonRuleK;
  spcStageCol?: string | null;
  spcDataLayout?: SpcDataLayout;
  spcValueCol?: string | null;
  spcSubgroupCol?: string | null;
  /** 保存当时实际解析结果，专项报告可直接说明变量/角色；回看仍按上面选择重算。 */
  spcResolvedLayout?: string;
  spcResolvedVariableName?: string;
  spcResolvedRoleNote?: string;
  lsl?: number; usl?: number; tgt?: number; lslOn?: boolean; uslOn?: boolean;
  capabilityBins?: number;
  /** 能力子组口径(批次716-N);缺失即旧记录,回放时回落「沿用 SPC 角色」而非继承当前页面。 */
  capSubgroupMode?: 'spc' | 'const' | 'stacked';
  capSubgroupSize?: number;
  capValueCol?: string | null;
  capSubgroupIdCol?: string | null;
  gageUseReal?: boolean;
  gageValueName?: string | null;
  gagePartName?: string | null;
  gageOperatorName?: string | null;
  gageRequestedReal?: boolean;
  gageSourceReal?: boolean;
  aqlLot?: number; aqlLevel?: InspectionLevel; aqlAQL?: number; aqlMethod?: AqlMethod; aqlAcMethod?: AqlAcMethod;
  aqlSwitch?: SwitchStatus;
  doeView?: DoeView; doeTab?: DoeTab; hypoTab?: HypoTab; paretoView?: ParetoView;
  anovaShowDemo?: boolean;
  t1ColName?: string | null; t1Mu0?: number | null;
  t2ColAName?: string | null; t2ColBName?: string | null;
  regXName?: string | null; regYName?: string | null;
  paretoMergeOther?: boolean; paretoThreshold?: number; paretoShowDemo?: boolean; paretoData?: ParetoModel;
  fishboneData?: FishboneData;
  fishboneIsDemo?: boolean;
  /** SPC/能力历史自带当时的原始工作表，不依赖“最近 5 个数据集”。 */
  /** v4/v5 兼容内嵌载荷；新记录优先用 sourceDataKey 去重存储。 */
  sourceData?: AnalysisSourceData;
  sourceDataKey?: string;
  pChartData?: { name: string; counts: number[]; sampleSize: number; sampleSizes?: number[] };
  cChartData?: { name: string; counts: number[] };
  // 列选择随分析记录一起快照,保证回看时"页面所见 = 保存时"(否则重算会用当前选择)
  doeFactorCols?: string[] | null; doeRespCol?: string | null;
  doeModelTerms?: string[] | null; doeIncludeCurvature?: boolean;
  anovaMode?: AnovaMode; anovaRespName?: string | null; anovaFactorName?: string | null;
  /** 描述性统计一次只分析一个数值列。 */
  activeVar?: string;
}

export interface SavedAnalysis {
  id: string;
  kind: AnalysisKind;
  title: string;
  datasetName: string;
  metric: string;
  status: string;
  statusColor: string;
  statusBg: string;
  createdAt: number;
  snapshot: AnalysisSnapshot;
}

const LS_KEY = 'qp-analyses-v1';
const LS_ANALYSIS_DATA = 'qp-analysis-data-v1';
const MAX_SAVED = 40;
const protectedCorruptAnalysisStores = new Map<string, { raw: string; detail: string }>();

function quarantineAnalysisStore(key: string, raw: string, detail: string): boolean {
  const preserved = preserveCorruptStore(key, raw, detail);
  if (preserved) protectedCorruptAnalysisStores.delete(key);
  else protectedCorruptAnalysisStores.set(key, { raw, detail });
  return preserved;
}

function canReplaceAnalysisStore(key: string): boolean {
  const blocked = protectedCorruptAnalysisStores.get(key);
  if (!blocked) return true;
  let live: string | null = blocked.raw;
  try { live = localStorage.getItem(key); } catch { /* 使用已捕获原文重试 */ }
  if (live == null) {
    protectedCorruptAnalysisStores.delete(key);
    return true;
  }
  return quarantineAnalysisStore(key, live, blocked.detail);
}

type AnalysisDataLibrary = Record<string, AnalysisSourceData>;

function sourceDataKey(data: AnalysisSourceData): string {
  const text = JSON.stringify(data);
  // FNV-1a 32-bit + 字节长度：作为本地去重键，不用于安全校验。
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `d${(hash >>> 0).toString(36)}-${text.length.toString(36)}`;
}

function loadAnalysisDataLibrary(): AnalysisDataLibrary {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_ANALYSIS_DATA);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    const detail = projectStoreValidationError(LS_ANALYSIS_DATA, parsed);
    if (detail) {
      quarantineAnalysisStore(LS_ANALYSIS_DATA, raw, detail);
      return {};
    }
    return parsed as AnalysisDataLibrary;
  } catch {
    if (raw) quarantineAnalysisStore(LS_ANALYSIS_DATA, raw, 'JSON 解析失败或写入被截断');
    return {};
  }
}

function storeAnalysisSourceData(data: AnalysisSourceData): string | null {
  const baseKey = sourceDataKey(data);
  const library = loadAnalysisDataLibrary();
  const serialized = JSON.stringify(data);
  let key = baseKey;
  let collision = 1;
  while (library[key] && JSON.stringify(library[key]) !== serialized) {
    key = `${baseKey}-${collision++}`;
  }
  if (library[key]) return key;
  if (!canReplaceAnalysisStore(LS_ANALYSIS_DATA)) return null;
  try {
    localStorage.setItem(LS_ANALYSIS_DATA, JSON.stringify({ ...library, [key]: data }));
    return key;
  } catch {
    return null;
  }
}

function resolveSnapshotSourceData(snapshot: AnalysisSnapshot): AnalysisSourceData | null {
  if (snapshot.sourceData) return snapshot.sourceData;
  if (!snapshot.sourceDataKey) return null;
  return loadAnalysisDataLibrary()[snapshot.sourceDataKey] ?? null;
}

function pruneAnalysisDataLibrary(saved: SavedAnalysis[]) {
  const keep = new Set(saved.map((analysis) => analysis.snapshot.sourceDataKey).filter((key): key is string => !!key));
  const library = loadAnalysisDataLibrary();
  const next = Object.fromEntries(Object.entries(library).filter(([key]) => keep.has(key)));
  if (!canReplaceAnalysisStore(LS_ANALYSIS_DATA)) return;
  try {
    if (Object.keys(next).length > 0) localStorage.setItem(LS_ANALYSIS_DATA, JSON.stringify(next));
    else localStorage.removeItem(LS_ANALYSIS_DATA);
  } catch { /* 清理失败不影响已保存分析 */ }
}

function analysisUsesWorksheet(kind: AnalysisKind, snapshot: AnalysisSnapshot): boolean {
  if (kind === 'spc') return snapshot.spcType !== 'p' && snapshot.spcType !== 'c';
  return kind === 'capability' || kind === 'anova' || kind === 'doe' || kind === 'summary'
    || (kind === 'gagerr' && (snapshot.gageRequestedReal === true || snapshot.gageSourceReal === true));
}

function currentGageStudy() {
  const app = useApp.getState();
  const data = useData.getState();
  const prepared = prepareGageStudy(data.model, data.textCols, {
    valueColumn: app.gageValueName,
    partColumn: app.gagePartName,
    operatorColumn: app.gageOperatorName,
    pendingCells: data.pendingCells,
  });
  return { requestedReal: !data.model.isDemo && app.gageUseReal, prepared };
}

function attachWorksheetSnapshot(snapshot: AnalysisSnapshot) {
  const data = useData.getState();
  const rows = data.model.subs.map((subgroup) => [...subgroup.vals]);
  const flattened = rows.flat();
  const hasDistinctIndiv = flattened.length !== data.model.indiv.length
    || flattened.some((value, index) => value !== data.model.indiv[index]);
  const sourceData: AnalysisSourceData = {
    name: data.model.name,
    colNames: [...data.model.colNames],
    rows,
    textCols: data.textCols.map((column) => ({ name: column.name, values: [...column.values] })),
    pendingCells: data.pendingCells.map((cell) => ({ ...cell })),
    isDemo: data.model.isDemo || undefined,
    indivSeries: hasDistinctIndiv ? [...data.model.indiv] : undefined,
  };
  const key = storeAnalysisSourceData(sourceData);
  if (key) snapshot.sourceDataKey = key;
  else snapshot.sourceData = sourceData;
}

const OK = { color: '#2c8a45', bg: '#e8f4ea' };
const WARN = { color: '#e0902a', bg: '#fcf3e3' };
const BAD = { color: '#c22f2f', bg: '#fdecec' };
const INFO = { color: '#1f6fb2', bg: '#e7f0f9' };

const SPC_TITLE: Record<SpcType, string> = {
  'xbar-r': 'X̄-R 控制图', 'xbar-s': 'X̄-S 控制图', 'i-mr': 'I-MR 控制图',
  ewma: 'EWMA 控制图', cusum: 'CUSUM 控制图', p: 'P 控制图', c: 'C 控制图',
};

/**
 * 统一 SPC 页面红点、列表、结论卡与保存摘要的最小判异单元。
 * 窗口型准则的 core list 记录「窗口触发点」，而 viol 记录图上实际标红的所有点；
 * 这里把触发窗口展开成实际点，使列表与图一一对应。
 */
export interface SpcViolationItem {
  i: number;
  rule: number;
  desc: string;
  chartLabel: string;
}

export function expandSpcRuleItems(
  viol: ReadonlySet<number>,
  list: ReadonlyArray<{ i: number; rule: number; desc: string }>,
  chartLabel: string,
  ruleK: NelsonRuleK = DEFAULT_RULE_K,
): SpcViolationItem[] {
  // 游程型准则窗口长度随 K 值变化;准则 1/5/6 的 list 已按实际点逐条记录,窗口恒为 1。
  const windowLength: Partial<Record<number, number>> = {
    2: ruleK.k2, 3: ruleK.k3, 4: ruleK.k4, 7: ruleK.k7, 8: ruleK.k8,
  };
  const out: SpcViolationItem[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const len = windowLength[item.rule] ?? 1;
    const start = Math.max(0, item.i - len + 1);
    for (let i = start; i <= item.i; i++) {
      if (!viol.has(i)) continue;
      const key = `${chartLabel}:${item.rule}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ i, rule: item.rule, desc: item.desc, chartLabel });
    }
  }
  return out.sort((a, b) => a.i - b.i || a.rule - b.rule);
}

export function uniqueSpcPointCount(items: ReadonlyArray<Pick<SpcViolationItem, 'i'>>): number {
  return new Set(items.map((item) => item.i)).size;
}

const HYPO_TITLE: Record<HypoTab, string> = {
  anova: '单因子 ANOVA', t1: '单样本 t 检验', t2: '双样本 t 检验', reg: '相关与回归',
};

/** 依当前页 + 数据集 + 参数,生成一条分析记录（不入栈,仅计算摘要） */
function buildSummary(kind: AnalysisKind): Omit<SavedAnalysis, 'id' | 'createdAt' | 'datasetName' | 'snapshot'> | null {
  const app = useApp.getState();
  const { model: M, pModel, cModel } = useData.getState();
  switch (kind) {
    case 'spc': {
      const dataState = useData.getState();
      const prepared = prepareSpcData(M, dataState.textCols, {
        layout: app.spcDataLayout, valueColumn: app.spcValueCol, subgroupColumn: app.spcSubgroupCol,
        pendingCells: dataState.pendingCells,
      });
      if (prepared.error && app.spcType !== 'p' && app.spcType !== 'c') {
        return {
          kind, title: SPC_TITLE[app.spcType], metric: '数据角色未配置',
          status: '未分析', ...pick(WARN),
        };
      }
      const SM = prepared.model ?? M;
      const effType: SpcType = !SM.hasSubgroups && (app.spcType === 'xbar-r' || app.spcType === 'xbar-s')
        ? 'i-mr'
        : app.spcType;
      const rows = SM.subs.map((s) => s.vals);
      const means = SM.subs.map((s) => s.mean);
      const ruleItems = (data: number[], cl: number, sigma: number, chartLabel: string) => {
        const r = evalRules(data, cl, sigma, app.spcRules, app.spcRuleK);
        return expandSpcRuleItems(r.viol, r.list, chartLabel, app.spcRuleK);
      };
      const limitedItems = (data: number[], cl: number, ucl: number | number[], lcl: number | number[], chartLabel: string, indexOffset = 0) => {
        const r = evalLimitedRules(data, cl, ucl, lcl, app.spcRules, app.spcRuleK);
        return expandSpcRuleItems(r.viol, r.list, chartLabel, app.spcRuleK).map((item) => ({ ...item, i: item.i + indexOffset }));
      };
      let items: SpcViolationItem[];
      let stageCount = 0;

      if (effType === 'xbar-r') {
        const stageLabels = app.spcStageCol
          ? prepared.textCols.find((c) => c.name === app.spcStageCol)?.values
          : undefined;
        const stageError = app.spcStageCol
          ? stageLabels
            ? stageValidationError(stageLabels, SM.k)
            : `找不到阶段列“${app.spcStageCol}”`
          : null;
        if (stageError) {
          return {
            kind, title: `${SPC_TITLE[effType]} · 分阶段未运行`, metric: stageError,
            status: '未分析', ...pick(WARN),
          };
        }
        const canUseStages = Boolean(stageLabels);
        if (canUseStages && stageLabels) {
          const x = stagedXbar(rows, stageLabels, app.spcRules);
          const r = stagedRange(rows, stageLabels, app.spcRules);
          items = [
            ...expandSpcRuleItems(x.viol, x.list, 'X̄'),
            ...expandSpcRuleItems(r.viol, r.list, 'R'),
          ];
          stageCount = x.segments.length;
        } else {
          items = [
            ...ruleItems(means, SM.xbarbar, (SM.uclX - SM.xbarbar) / 3, 'X̄'),
            ...limitedItems(SM.subs.map((s) => s.range), SM.rbar, SM.uclR, SM.lclR, 'R'),
          ];
        }
      } else if (effType === 'xbar-s') {
        items = [
          ...ruleItems(means, SM.xbarbar, (SM.uclXs - SM.xbarbar) / 3, 'X̄'),
          ...limitedItems(SM.svals, SM.sbar, SM.uclS, SM.lclS, 'S'),
        ];
      } else if (effType === 'i-mr') {
        items = [
          ...ruleItems(SM.indiv, SM.indMean, (SM.iUcl - SM.indMean) / 3, 'I'),
          // MR[0] 无定义，图上第 1 个 MR 对应原始观测 2，故全局点索引 +1。
          ...limitedItems(SM.mr.slice(1) as number[], SM.mrbar, SM.mrUcl, 0, 'MR', 1),
        ];
      } else if (effType === 'ewma') {
        const data = SM.hasSubgroups ? means : SM.indiv;
        const mu = SM.hasSubgroups ? SM.xbarbar : SM.indMean;
        const sigma = SM.hasSubgroups ? SM.sigmaWithin / Math.sqrt(SM.n) : SM.iSig;
        const r = ewmaSeries(data, mu, sigma);
        items = [...r.viol].map((i) => ({ i, rule: 1, desc: 'EWMA 超出时变控制限', chartLabel: 'EWMA' }));
      } else if (effType === 'cusum') {
        const data = SM.hasSubgroups ? means : SM.indiv;
        const mu = SM.hasSubgroups ? SM.xbarbar : SM.indMean;
        const sigma = SM.hasSubgroups ? SM.sigmaWithin / Math.sqrt(SM.n) : SM.iSig;
        const r = cusumSeries(data, mu, sigma, 0.5, SM.hasSubgroups ? 4 : 5);
        items = [...r.viol].map((i) => ({ i, rule: 1, desc: '累积和超出判定限 H', chartLabel: 'CUSUM' }));
      } else if (effType === 'p') {
        items = limitedItems(pModel.pprop, pModel.pbar, pModel.pUcls, pModel.pLcls, 'P');
      } else {
        items = limitedItems(cModel.cdata, cModel.cbar, cModel.cUcl, cModel.cLcl, 'C');
      }

      // 不同准则、不同子图命中同一子组/观测时，依然只是 1 个实际失控点。
      const n = uniqueSpcPointCount(items);
      const stagePrefix = stageCount > 0 ? `${stageCount} 阶段 · ` : '';
      return {
        kind, title: `${SPC_TITLE[effType]}${stageCount > 0 ? ' · 分阶段' : ''}`,
        metric: n > 0 ? `${stagePrefix}${n} 个失控点` : `${stagePrefix}过程受控`,
        status: n > 0 ? '需关注' : '受控', ...pick(n > 0 ? BAD : OK),
      };
    }
    case 'capability': {
      const dataState = useData.getState();
      const prepared = resolveCapabilityMeasurementData(M, dataState.textCols);
      if (prepared.error || !prepared.model) {
        return {
          kind, title: '过程能力分析', metric: '数据角色未配置',
          status: '未分析', ...pick(WARN),
        };
      }
      const CM = prepared.model;
      const spec = {
        lsl: app.lslOn ? app.lsl : null, tgt: app.tgt, usl: app.uslOn ? app.usl : null,
      };
      const inputError = capabilityInputError(CM.all, CM.sigmaWithin, spec);
      if (inputError) {
        return { kind, title: '过程能力分析', metric: inputError, status: '未分析', ...pick(WARN) };
      }
      const cap = computeCapability(CM.all, CM.sigmaWithin, spec);
      // P0-4:与能力页/专项报告共用唯一判定器——过程失控时保存记录不得给绿色「能力充足」。
      const ad = CM.all.length >= 8 ? andersonDarling(CM.all) : null;
      const assessment = assessCapability({
        cpk: cap.cpk, verdict: cap.verdict, adP: ad ? ad.p : null, n: CM.all.length,
        spcViolations: countCapabilityViolations(CM, app.spcRules, app.spcRuleK),
      });
      return {
        kind, title: '过程能力分析', metric: `Cpk ${nf(cap.cpk, 2)}`,
        status: assessment.status,
        ...pick(assessment.level === 'ok' ? OK : assessment.level === 'warn' ? WARN : BAD),
      };
    }
    case 'gagerr': {
      const { requestedReal, prepared } = currentGageStudy();
      try {
        if (requestedReal && !prepared.ok) {
          return { kind, title: '测量系统分析 Gage R&R', metric: prepared.reason, status: '未分析', ...pick(WARN) };
        }
        const g = requestedReal && prepared.ok
          ? computeGageRR(prepared.study.observations, app.lslOn && app.uslOn ? app.usl - app.lsl : null)
          : computeGageRR(gageStudyData(), GAGE_TOLERANCE);
        const ok = g.verdict === 'acceptable';
        return {
          kind, title: `测量系统分析 Gage R&R${requestedReal ? '' : '(示例)'}`, metric: `GRR ${nf(g.totalGageRR, 1)}%`,
          status: requestedReal ? ok ? '可接受' : g.verdict === 'marginal' ? '临界' : '不可接受' : '演示',
          ...pick(requestedReal ? ok ? OK : WARN : INFO),
        };
      } catch (error) {
        return { kind, title: '测量系统分析 Gage R&R', metric: (error as Error).message, status: '未分析', ...pick(WARN) };
      }
    }
    case 'anova': {
      const tab = app.hypoTab;
      if (tab === 'anova') {
        // 与 ANOVA 页共用 buildAnovaGroups + store 选择,保证摘要=页面所见;真实数据不回落演示
        const { textCols, pendingCells } = useData.getState();
        const rows = M.subs.map((s) => s.vals);
        const eligibleTextCount = textCols.filter((column) => isDoeAnalysisColumn(column.name)).length;
        const effMode = M.isDemo ? null : resolveAnovaMode(
          app.anovaMode, M.colNames, rows, eligibleTextCount, app.anovaRespName, app.anovaFactorName,
        );
        if (M.isDemo || (effMode === null && app.anovaShowDemo)) {
          const a = oneWayAnova(anovaGroups().map((x) => x.vals));
          return { kind, title: `${HYPO_TITLE.anova}(示例)`, metric: `P ${nf(a.pValue, 3)}`, status: '演示', ...pick(INFO) };
        }
        const groups = effMode ? buildAnovaGroups(effMode, M.colNames, rows, textCols, app.anovaRespName, app.anovaFactorName) : null;
        if (!groups || !effMode) {
          return { kind, title: HYPO_TITLE.anova, metric: '数据不足(无有效分组)', status: '未分析', ...pick(WARN) };
        }
        const pendingCount = countAnovaPendingCells(
          effMode, M.colNames, rows, app.anovaRespName, app.anovaFactorName, pendingCells,
        );
        if (pendingCount > 0) {
          return { kind, title: HYPO_TITLE.anova, metric: `尚有 ${pendingCount} 格未录入`, status: '未分析', ...pick(WARN) };
        }
        // 宽表各列量纲悬殊:不把无意义的"显著"固化进摘要,给存疑标记(页面另有强告警与「数值因子」引导)
        if (effMode === 'wide' && wideScaleDisparate(groups)) {
          return { kind, title: HYPO_TITLE.anova, metric: '各列量纲悬殊·慎比', status: '存疑', ...pick(WARN) };
        }
        try {
          const a = oneWayAnova(groups.map((g) => g.vals));
          return {
            kind, title: HYPO_TITLE.anova, metric: `P ${nf(a.pValue, 3)}`,
            status: a.significant ? '显著' : '不显著', ...pick(a.significant ? INFO : OK),
          };
        } catch {
          return { kind, title: HYPO_TITLE.anova, metric: '数据不足', status: '未分析', ...pick(WARN) };
        }
      }
      const dataState = useData.getState();
      const indexFor = (name: string | null, fallback: number) => {
        const index = name ? M.colNames.indexOf(name) : -1;
        return index >= 0 ? index : fallback;
      };
      try {
        if (tab === 't1') {
          const column = indexFor(app.t1ColName, 0);
          const pending = dataState.pendingCells.filter((cell) => cell.row >= 0 && cell.row < M.k && cell.col === column).length;
          if (pending) return { kind, title: HYPO_TITLE.t1, metric: `尚有 ${pending} 格未录入`, status: '未分析', ...pick(WARN) };
          const result = oneSampleT(M.subs.map((sub) => sub.vals[column]), app.t1Mu0 ?? app.tgt);
          return { kind, title: HYPO_TITLE.t1, metric: `P ${nf(result.p, 3)}`, status: result.significant ? '显著' : '不显著', ...pick(result.significant ? INFO : OK) };
        }
        if (tab === 't2') {
          const multi = M.colNames.length >= 2;
          if (!multi && !M.isDemo) {
            return {
              kind, title: HYPO_TITLE.t2, metric: '需要两个不同数值列', status: '未分析', ...pick(WARN),
            };
          }
          const first = indexFor(app.t2ColAName, 0);
          const namedSecond = indexFor(app.t2ColBName, multi ? 1 : 0);
          const second = multi && first === namedSecond ? (first === 0 ? 1 : 0) : namedSecond;
          const groups = multi
            ? [M.subs.map((sub) => sub.vals[first]), M.subs.map((sub) => sub.vals[second])]
            : anovaGroups().slice(0, 2).map((group) => group.vals);
          const pending = multi ? dataState.pendingCells.filter((cell) =>
            cell.row >= 0 && cell.row < M.k && (cell.col === first || cell.col === second)).length : 0;
          if (pending) return { kind, title: HYPO_TITLE.t2, metric: `尚有 ${pending} 格未录入`, status: '未分析', ...pick(WARN) };
          const result = twoSampleT(groups[0], groups[1]);
          return { kind, title: `${HYPO_TITLE.t2}${multi ? '' : '(示例)'}`, metric: `P ${nf(result.p, 3)}`, status: multi ? result.significant ? '显著' : '不显著' : '演示', ...pick(multi ? result.significant ? INFO : OK : INFO) };
        }
        const x = indexFor(app.regXName, 0);
        const y = indexFor(app.regYName, M.colNames.length >= 2 ? 1 : 0);
        if (M.colNames.length < 2 || x === y) return { kind, title: HYPO_TITLE.reg, metric: '需要两个不同数值列', status: '未分析', ...pick(WARN) };
        const pending = dataState.pendingCells.filter((cell) =>
          cell.row >= 0 && cell.row < M.k && (cell.col === x || cell.col === y)).length;
        if (pending) return { kind, title: HYPO_TITLE.reg, metric: `尚有 ${pending} 格未录入`, status: '未分析', ...pick(WARN) };
        const result = linearRegression(M.subs.map((sub) => sub.vals[x]), M.subs.map((sub) => sub.vals[y]));
        return { kind, title: HYPO_TITLE.reg, metric: `R² ${nf(result.r2, 3)} · P ${nf(result.p, 3)}`, status: result.significant ? '斜率显著' : '斜率不显著', ...pick(result.significant ? INFO : OK) };
      } catch {
        return { kind, title: HYPO_TITLE[tab], metric: '数据不足', status: '未分析', ...pick(WARN) };
      }
    }
    case 'pareto': {
      if (app.paretoView === 'fishbone') {
        const { data, isDemo } = loadFishboneState();
        const causeCount = data.categories.reduce((sum, category) => sum + category.causes.length, 0);
        if (isDemo) {
          return { kind, title: '因果图（鱼骨图）· 内置示例', metric: `${causeCount} 条示例原因`, status: '演示', ...pick(INFO) };
        }
        return causeCount > 0
          ? { kind, title: `因果图（鱼骨图）· ${data.problem || '未命名问题'}`, metric: `${causeCount} 条潜在原因`, status: '已分析', ...pick(INFO) }
          : { kind, title: `因果图（鱼骨图）· ${data.problem || '未命名问题'}`, metric: '尚未录入原因', status: '未分析', ...pick(WARN) };
      }
      const pm = useData.getState().paretoModel;
      if (!pm || pm.rows.length === 0) {
        return app.paretoShowDemo
          ? { kind, title: '帕累托图 · 内置示例', metric: '示例数据', status: '演示', ...pick(INFO) }
          : { kind, title: '帕累托图 · 缺陷分析', metric: '尚未导入数据', status: '未分析', ...pick(WARN) };
      }
      const sorted = [...pm.rows].sort((a, b) => b.count - a.count);
      const total = sorted.reduce((a, r) => a + r.count, 0) || 1;
      const topN = Math.min(2, sorted.length);
      const pct = Math.round((sorted.slice(0, topN).reduce((a, r) => a + r.count, 0) / total) * 100);
      return { kind, title: `帕累托图 · ${pm.name}`, metric: `Top${topN} = ${pct}%`, status: '已分析', ...pick(OK) };
    }
    case 'doe': {
      if (app.doeTab === 'create') {
        return { kind, title: '实验设计 · 创建配置', metric: '尚未运行分析', status: '设计中', ...pick(WARN) };
      }
      if (M.isDemo) {
        const r = analyzeDoe();
        const sig = r.terms.filter((t) => t.sig).map((t) => t.name.split(' ')[0]);
        return {
          kind, title: '实验设计 · 2³ 全因子(示例)', metric: sig.length ? `${sig.join('、')} 显著` : '无显著项',
          status: '演示', ...pick(INFO),
        };
      }
      // 真实数据:与 DOE 分析页共用 resolveDoeColumns(同一选择/同一 4 因子上限),
      // 保证「保存到项目的汇总卡」与分析页所见一致,避免页面出结果而卡片显示未分析。
      const nc = M.colNames.length;
      if (nc >= 3) {
        const { factorIdx, respIdx } = resolveDoeColumns(M.colNames, app.doeFactorCols, app.doeRespCol);
        const facs = factorIdx.map((i) => ({ name: M.colNames[i], values: M.subs.map((s) => s.vals[i]) }));
        const resp = M.subs.map((s) => s.vals[respIdx]);
        // 检查顺序与分析页一致:先看因子结构、再看响应是否录入,避免页面与卡片给出不同诊断
        const blocks = resolveDoeBlockValues(M.colNames, M.subs.map((sub) => sub.vals), useData.getState().textCols);
        const det = detectFactorial(facs, resp, { blocks });
        if (!det.ok) {
          return { kind, title: '实验设计 (DOE)', metric: '数据非因子设计', status: '未分析', ...pick(WARN) };
        }
        const pendingRows = useData.getState().pendingCells.filter((p) => p.col === respIdx).length;
        if (new Set(resp).size < 2 || pendingRows > 0) {
          return { kind, title: '实验设计 (DOE)', metric: pendingRows > 0 ? `尚有 ${pendingRows} 行未录入` : '响应尚未录入', status: '未分析', ...pick(WARN) };
        }
        const availableTerms = factorialModelTerms(det.design.factorNames);
        const selectedTerms = app.doeModelTerms?.filter((term) => availableTerms.includes(term));
        const fr = analyzeFactorial(det.design, {
          terms: selectedTerms && selectedTerms.length > 0 ? selectedTerms : availableTerms,
          includeCurvature: app.doeIncludeCurvature,
        });
        if (fr.terms.length === 0) {
          return {
            kind, title: `实验设计 · ${det.design.factorNames.length} 因子`,
            metric: '所选模型项全部不可估计', status: '未分析', ...pick(WARN),
          };
        }
        const sig = fr.terms.filter((t) => t.sig).map((t) => t.name);
        return {
          kind, title: `实验设计 · ${det.design.factorNames.length} 因子`,
          metric: sig.length ? `${sig.slice(0, 3).join('、')} 显著` : '无显著项',
          status: '已分析', ...pick(INFO),
        };
      }
      return { kind, title: '实验设计 (DOE)', metric: '数据非因子设计', status: '未分析', ...pick(WARN) };
    }
    case 'aql': {
      const sw = normalizeSwitchStatus(app.aqlSwitch);
      const statePlans = plansByState(app.aqlLot, app.aqlLevel, app.aqlAQL);
      const plan = statePlans[sw.state];
      const stateLabel = sw.state === 'tightened' ? '加严' : sw.state === 'reduced' ? '放宽' : '正常';
      return {
        kind,
        title: sw.suspended ? 'AQL 历史摘要 · 已暂停' : plan.fullInspect ? 'AQL 历史摘要 · 100% 全检' : `AQL 历史摘要 · ${stateLabel}方案`,
        metric: `保存时 ${plan.fullInspect ? 'N' : 'n'}=${plan.n} Ac=${plan.ac} Re=${plan.re}`,
        status: sw.suspended ? '保存时：等待纠正' : plan.fullInspect ? '保存时：全检' : `保存时：${stateLabel}`,
        ...pick(sw.suspended ? BAD : plan.fullInspect ? WARN : INFO),
      };
    }
    case 'summary': {
      const column = resolveNumericColumn(M, app.activeVar);
      const d = computeDescriptive(column.values);
      return {
        kind, title: `描述性统计 · ${column.name}`,
        metric: `x̄ ${nf(d.mean, 3)} · s ${nf(d.stdev, 3)}`,
        status: !d.adAvailable ? '已汇总' : d.ad.normal ? '正态' : '非正态',
        ...pick(!d.adAvailable ? INFO : d.ad.normal ? OK : WARN),
      };
    }
    default:
      return null;
  }
}

function pick(c: { color: string; bg: string }) {
  return { statusColor: c.color, statusBg: c.bg };
}

function snapshotOf(kind: AnalysisKind): AnalysisSnapshot {
  const a = useApp.getState();
  const snap: AnalysisSnapshot = { snapshotVersion: 5 };
  if (kind === 'spc') {
    snap.spcType = a.spcType;
    snap.spcRules = { ...a.spcRules };
    snap.spcRuleK = { ...a.spcRuleK };
    snap.spcStageCol = a.spcStageCol;
  }
  // 能力指标依赖与 SPC 相同的测量列/子组角色，因此历史回看也必须保存这组参数。
  if (kind === 'spc' || kind === 'capability') {
    snap.spcDataLayout = a.spcDataLayout;
    snap.spcValueCol = a.spcValueCol;
    snap.spcSubgroupCol = a.spcSubgroupCol;
    const data = useData.getState();
    // 能力口径由 capSubgroup* 决定(批次716-N),不入快照则历史记录回放会被当前页面配置静默改口径。
    const prepared = kind === 'capability'
      ? resolveCapabilityMeasurementData(data.model, data.textCols)
      : prepareSpcData(data.model, data.textCols, {
          layout: a.spcDataLayout, valueColumn: a.spcValueCol, subgroupColumn: a.spcSubgroupCol,
          pendingCells: data.pendingCells,
        });
    if (!prepared.error) {
      snap.spcResolvedLayout = prepared.layoutLabel;
      snap.spcResolvedVariableName = prepared.variableName;
      snap.spcResolvedRoleNote = prepared.note;
    }
    if (kind === 'spc' && a.spcType === 'p') {
      snap.pChartData = {
        name: data.pModel.name,
        counts: [...data.pModel.pdef],
        sampleSize: data.pModel.pN,
        sampleSizes: data.pModel.pVariableN ? [...data.pModel.pNs] : undefined,
      };
    } else if (kind === 'spc' && a.spcType === 'c') {
      snap.cChartData = { name: data.cModel.name, counts: [...data.cModel.cdata] };
    }
  }
  if (kind === 'capability') {
    snap.lsl = a.lsl; snap.usl = a.usl; snap.tgt = a.tgt; snap.lslOn = a.lslOn; snap.uslOn = a.uslOn;
    snap.capabilityBins = a.capabilityBins;
    snap.capSubgroupMode = a.capSubgroupMode;
    snap.capSubgroupSize = a.capSubgroupSize;
    snap.capValueCol = a.capValueCol;
    snap.capSubgroupIdCol = a.capSubgroupIdCol;
  }
  if (kind === 'gagerr') {
    // %公差直接依赖规格宽度；历史研究若只恢复列角色而不恢复当时的规格，
    // 同一组量具数据会在回看时得到不同结论。
    snap.lsl = a.lsl;
    snap.usl = a.usl;
    snap.lslOn = a.lslOn;
    snap.uslOn = a.uslOn;
    snap.gageUseReal = a.gageUseReal;
    snap.gageValueName = a.gageValueName;
    snap.gagePartName = a.gagePartName;
    snap.gageOperatorName = a.gageOperatorName;
    const current = currentGageStudy();
    snap.gageRequestedReal = current.requestedReal;
    snap.gageSourceReal = current.requestedReal && current.prepared.ok;
  }
  if (kind === 'aql') {
    snap.aqlLot = a.aqlLot; snap.aqlLevel = a.aqlLevel; snap.aqlAQL = a.aqlAQL;
    snap.aqlMethod = 'gb'; snap.aqlAcMethod = 'gb';
    // 标题/指标已经固化保存时的状态摘要；责任账本只保留在活跃 AQL store 中。
    // 历史卡不再复制整本 records，避免 40 个摘要把同一账本重复存储 40 次。
  }
  if (kind === 'doe') {
    snap.doeView = a.doeView;
    snap.doeTab = a.doeTab;
    snap.doeFactorCols = a.doeFactorCols;
    snap.doeRespCol = a.doeRespCol;
    snap.doeModelTerms = a.doeModelTerms ? [...a.doeModelTerms] : null;
    snap.doeIncludeCurvature = a.doeIncludeCurvature;
  }
  if (kind === 'anova') {
    snap.hypoTab = a.hypoTab;
    snap.anovaMode = a.anovaMode;
    snap.anovaRespName = a.anovaRespName;
    snap.anovaFactorName = a.anovaFactorName;
    snap.anovaShowDemo = a.anovaShowDemo;
    snap.t1ColName = a.t1ColName;
    snap.t1Mu0 = a.t1Mu0;
    snap.t2ColAName = a.t2ColAName;
    snap.t2ColBName = a.t2ColBName;
    snap.regXName = a.regXName;
    snap.regYName = a.regYName;
  }
  if (kind === 'pareto') {
    snap.paretoView = a.paretoView;
    snap.paretoMergeOther = a.paretoMergeOther;
    snap.paretoThreshold = a.paretoThreshold;
    snap.paretoShowDemo = a.paretoShowDemo;
    if (a.paretoView === 'fishbone') {
      const fishbone = loadFishboneState();
      snap.fishboneData = {
        problem: fishbone.data.problem,
        categories: fishbone.data.categories.map((category) => ({ name: category.name, causes: [...category.causes] })),
      };
      snap.fishboneIsDemo = fishbone.isDemo;
    } else {
      const pm = useData.getState().paretoModel;
      if (pm) snap.paretoData = { name: pm.name, rows: pm.rows.map((r) => ({ ...r })) };
    }
  }
  if (kind === 'summary') {
    snap.activeVar = resolveNumericColumn(useData.getState().model, a.activeVar).name;
  }
  if (analysisUsesWorksheet(kind, snap)) attachWorksheetSnapshot(snap);
  return snap;
}

/** v1.33 起 AQL 历史卡只保留摘要；升级时移除旧卡里从未被回看消费的重复责任账本。 */
export function normalizeSavedAnalysesForStorage(value: unknown): SavedAnalysis[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is SavedAnalysis => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((analysis) => {
      if (analysis.kind !== 'aql' || !analysis.snapshot?.aqlSwitch) return analysis;
      const snapshot = { ...analysis.snapshot };
      delete snapshot.aqlSwitch;
      return { ...analysis, snapshot };
    })
    .filter((analysis) => !projectStoreValidationError(LS_KEY, [analysis]));
}

function load(): SavedAnalysis[] {
  let parsed: unknown;
  let normalized: SavedAnalysis[];
  let text: string | null = null;
  try {
    text = localStorage.getItem(LS_KEY);
    if (!text) return [];
    parsed = JSON.parse(text);
    const detail = projectStoreValidationError(LS_KEY, parsed);
    if (detail) {
      quarantineAnalysisStore(LS_KEY, text, detail);
      return [];
    }
    normalized = normalizeSavedAnalysesForStorage(parsed);
  } catch {
    if (text) quarantineAnalysisStore(LS_KEY, text, 'JSON 解析失败或写入被截断');
    return [];
  }
  // 旧 AQL 快照清理只是尽力迁移；写回失败不能让已成功读取的历史在本次会话中消失。
  try {
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      localStorage.setItem(LS_KEY, JSON.stringify(normalized));
    }
  } catch { /* 保留内存中的 normalized，稍后有空间时再迁移 */ }
  return normalized;
}

function persist(saved: SavedAnalysis[]): boolean {
  if (!canReplaceAnalysisStore(LS_KEY)) return false;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}

registerProjectLifecycleHooks({
  beforeExport: () => {
    if (protectedCorruptAnalysisStores.size > 0) {
      throw new Error(`损坏的分析存储尚未成功复制到隔离区（${[...protectedCorruptAnalysisStores.keys()].join('、')}），项目未导出`);
    }
  },
});

const ANALYSIS_PAGES: AnalysisKind[] = ['spc', 'capability', 'gagerr', 'anova', 'pareto', 'doe', 'aql', 'summary'];

interface AnalysesState {
  saved: SavedAnalysis[];
  /** 最近一次保存失败原因；成功保存或开始下一次保存时清空。 */
  lastError: string | null;
  /** 保存当前页的分析为一条记录;非分析页返回 null */
  saveCurrent(): SavedAnalysis | null;
  remove(id: string): boolean;
  /** 精确恢复历史分析；异步数据集读取失败时返回 false，且不回放参数或跳页。 */
  restore(id: string): Promise<boolean>;
}

export const useAnalyses = create<AnalysesState>((set, get) => ({
  saved: load(),
  lastError: null,

  saveCurrent: () => {
    set({ lastError: null });
    const page = useApp.getState().page;
    if (!ANALYSIS_PAGES.includes(page as AnalysisKind)) return null;
    const kind = page as AnalysisKind;
    const data = useData.getState();
    const app = useApp.getState();
    if (kind === 'summary') {
      const column = resolveNumericColumn(data.model, app.activeVar);
      const pending = data.pendingCells.filter((cell) => cell.col === column.index).length;
      if (pending > 0) {
        const lastError = `「${column.name}」仍有 ${pending} 个待录入单元格，描述性统计未运行，分析未保存`;
        set({ lastError });
        sessionLog(`保存分析失败 描述性统计 · ${lastError}`);
        return null;
      }
    }
    if (kind === 'anova' && app.hypoTab === 't2' && !data.model.isDemo && data.model.n < 2) {
      const lastError = '双样本 t 检验需要两个不同的数值列；当前真实工作表只有一列，分析未保存';
      set({ lastError });
      sessionLog(`保存分析失败 双样本 t 检验 · ${lastError}`);
      return null;
    }
    const summary = buildSummary(kind);
    if (!summary) return null;
    const datasetName = kind === 'pareto'
      ? app.paretoView === 'fishbone'
        ? `鱼骨图 · ${loadFishboneState().data.problem || '未命名问题'}`
        : (data.paretoModel?.name ?? (app.paretoShowDemo ? '内置示例' : '未导入数据'))
      : kind === 'gagerr' && !currentGageStudy().requestedReal
        ? '内置交叉 Gage R&R 研究'
      : kind === 'spc' && app.spcType === 'p'
        ? data.pModel.name
        : kind === 'spc' && app.spcType === 'c'
          ? data.cModel.name
          : data.model.name;
    const entry: SavedAnalysis = {
      ...summary,
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      createdAt: Date.now(),
      datasetName,
      snapshot: snapshotOf(kind),
    };
    const saved = [entry, ...get().saved].slice(0, MAX_SAVED);
    if (!persist(saved)) {
      // snapshotOf 可能已先写入去重数据；主索引写入失败时必须移除这份孤儿载荷。
      pruneAnalysisDataLibrary(get().saved);
      const lastError = '本地存储空间不足，分析未保存；请先导出项目或删除旧记录后重试';
      set({ lastError });
      sessionLog(`保存分析失败 ${entry.title} · ${lastError}`);
      return null;
    }
    set({ saved, lastError: null });
    pruneAnalysisDataLibrary(saved);
    sessionLog(`保存分析 ${entry.title} · ${entry.metric} · 数据集 ${entry.datasetName}`);
    return entry;
  },

  remove: (id) => {
    const saved = get().saved.filter((a) => a.id !== id);
    if (!persist(saved)) {
      // P1-6:删除未落盘时保留记录并如实报告失败,调用方不得提示「已删除」。
      const lastError = '本地存储空间不足，无法更新分析记录；请先导出项目后重试';
      set({ lastError });
      useApp.getState().showToast(lastError);
      return false;
    }
    set({ saved, lastError: null });
    pruneAnalysisDataLibrary(saved);
    return true;
  },

  restore: async (id) => {
    const a = get().saved.find((x) => x.id === id);
    if (!a) return false;
    const s = a.snapshot;
    let restoredEmbeddedData = false;
    const usesWorksheet = analysisUsesWorksheet(a.kind, s);
    const source = usesWorksheet ? resolveSnapshotSourceData(s) : null;
    if (source) {
      const restoredRows = source.rows.map((row) => [...row]);
      useData.getState().importMatrix(
        source.name,
        [...source.colNames],
        restoredRows,
        source.textCols.map((column) => ({ name: column.name, values: [...column.values] })),
        source.pendingCells?.map((cell) => ({ ...cell })) ?? [],
        {
          isDemo: source.isDemo === true,
          indivSeries: source.indivSeries?.map((value) => value),
          preserveSpecs: true,
        },
      );
      restoredEmbeddedData = true;
    } else if (a.kind === 'spc' && s.pChartData) {
      useData.getState().importCounts(
        'p', s.pChartData.name, [...s.pChartData.counts],
        s.pChartData.sampleSizes ? [...s.pChartData.sampleSizes] : s.pChartData.sampleSize,
      );
      restoredEmbeddedData = true;
    } else if (a.kind === 'spc' && s.cChartData) {
      useData.getState().importCounts('c', s.cChartData.name, [...s.cChartData.counts]);
      restoredEmbeddedData = true;
    }
    if (a.kind === 'spc' && (s.spcType === 'p' || s.spcType === 'c') && !restoredEmbeddedData) {
      useApp.getState().showToast('旧版 P/C 控制图记录未保存当时计数数据，无法准确重建；当前数据未作更改');
      sessionLog(`无法回看旧版 ${s.spcType.toUpperCase()} 记录 ${a.title} · 快照不含计数数据`);
      return false;
    }
    const missingWorksheetSnapshotMustBlock = usesWorksheet && !restoredEmbeddedData && (
      a.kind === 'anova' || a.kind === 'doe' || a.kind === 'summary'
      || (s.snapshotVersion ?? 0) >= 4
    );
    if (missingWorksheetSnapshotMustBlock) {
      useApp.getState().showToast('该分析的数据快照缺失，无法准确重建；当前数据未作更改');
      sessionLog(`无法回看分析 ${a.title} · 数据快照缺失`);
      return false;
    }
    // 仅旧版 SPC/能力等兼容记录可回退最近列表；v5 工作表分析一律使用精确快照。
    if (usesWorksheet && !restoredEmbeddedData && a.datasetName !== useData.getState().model.name) {
      const rec = useData.getState().recents.find((r) => r.name === a.datasetName);
      if (rec) {
        // 旧版快照回落最近列表时，随后会回放该记录自己的 SPC 角色；异步库读取也不能在完成时清掉它。
        const loaded = await useData.getState().loadRecent(a.datasetName, true);
        if (!loaded) {
          useApp.getState().showToast('旧版分析对应的数据集读取失败，无法准确重建；当前数据与分析参数未作更改');
          sessionLog(`无法回看旧版分析 ${a.title} · 数据集 ${a.datasetName} 读取失败`);
          return false;
        }
      } else {
        useApp.getState().showToast('旧版分析未保存原始数据，且对应数据集已不可用；当前数据未作更改');
        sessionLog(`无法回看旧版分析 ${a.title} · 数据集 ${a.datasetName} 已不可用`);
        return false;
      }
    }
    // 还原分析参数
    const legacyFishboneMissing = a.kind === 'pareto'
      && s.paretoView === 'fishbone' && !s.fishboneData;
    if (legacyFishboneMissing) {
      useApp.getState().showToast('旧版鱼骨图记录未保存问题与原因，无法重建；当前鱼骨图未作更改');
      sessionLog(`无法回看旧版鱼骨图记录 ${a.title} · 快照不含鱼骨数据`);
      return false;
    }
    const legacyParetoMissing = a.kind === 'pareto'
      && !s.paretoData && s.snapshotVersion == null && s.paretoShowDemo == null;
    if (legacyParetoMissing) {
      // 无法区分旧记录是示例还是哪份真实数据；保持当前工作不变，只明确告知不能回看。
      useApp.getState().showToast('旧版帕累托记录未保存数据，无法重建原图；当前帕累托数据未作更改');
      sessionLog(`无法回看旧版帕累托记录 ${a.title} · 快照不含数据`);
      return false;
    }
    if (a.kind === 'pareto') {
      if (s.paretoView === 'fishbone' && s.fishboneData) {
        try {
          saveFishboneState(s.fishboneData, s.fishboneIsDemo ?? false);
          useApp.getState().bumpFishboneRevision();
        } catch { /* 保持当前数据 */ }
      } else if (s.paretoData) {
        useData.getState().importPareto(s.paretoData.name, s.paretoData.rows.map((r) => ({ ...r })));
      } else {
        // 新版示例/空态记录先清空当前帕累托数据，绝不能把 B 的数据冒充回看结果。
        useData.getState().clearPareto();
      }
    }
    const patch: Record<string, unknown> = {};
    // 仅允许 AppState 中真实存在的快照字段，避免 paretoData 等大载荷污染 UI store。
    const appKeys: Array<keyof AnalysisSnapshot> = [
      'spcType', 'spcRules', 'spcStageCol', 'spcDataLayout', 'spcValueCol', 'spcSubgroupCol',
      'lsl', 'usl', 'tgt', 'lslOn', 'uslOn', 'capabilityBins',
      'gageUseReal', 'gageValueName', 'gagePartName', 'gageOperatorName',
      'doeView', 'doeTab', 'doeFactorCols', 'doeRespCol', 'doeModelTerms', 'doeIncludeCurvature',
      'hypoTab', 'anovaMode', 'anovaRespName', 'anovaFactorName', 'anovaShowDemo',
      't1ColName', 't1Mu0', 't2ColAName', 't2ColBName', 'regXName', 'regYName',
      'paretoView', 'paretoMergeOther', 'paretoThreshold', 'paretoShowDemo',
      'activeVar',
    ];
    for (const key of appKeys) if (s[key] !== undefined) patch[key] = s[key];
    // 能力子组口径随记录还原;旧记录无字段时回落默认「沿用 SPC 角色」,不继承当前页面配置。
    if (a.kind === 'capability') {
      patch.capSubgroupMode = s.capSubgroupMode ?? 'spc';
      patch.capSubgroupSize = typeof s.capSubgroupSize === 'number' && s.capSubgroupSize >= 2 && s.capSubgroupSize <= 10 ? Math.round(s.capSubgroupSize) : 5;
      patch.capValueCol = s.capValueCol ?? null;
      patch.capSubgroupIdCol = s.capSubgroupIdCol ?? null;
    }
    // v1.30 以前的 SPC 记录没有规则/阶段快照：采用当时的产品默认，而非继承当前页面条件。
    if (a.kind === 'spc' && !s.spcRules) patch.spcRules = { ...DEFAULT_SPC_RULES };
    // K 值随记录还原;旧记录无该字段时回到 Nelson/Minitab 标准值,不继承当前页面设置。
    if (a.kind === 'spc') patch.spcRuleK = normalizeRuleK(s.spcRuleK);
    if (a.kind === 'spc' && s.spcStageCol === undefined) patch.spcStageCol = null;
    if (a.kind === 'spc' && s.spcDataLayout === undefined) {
      patch.spcDataLayout = 'auto';
      patch.spcValueCol = null;
      patch.spcSubgroupCol = null;
    }
    // AQL 参数、状态机与责任账本共同构成一条持续演进的活跃检验流。历史记录只用于
    // 导航和查看保存摘要，任何字段都不能写回，否则会把历史方案与当前转移序列串线。
    if (a.kind === 'aql') {
      const current = useApp.getState();
      patch.aqlLot = current.aqlLot;
      patch.aqlLevel = current.aqlLevel;
      patch.aqlAQL = current.aqlAQL;
      patch.aqlMethod = current.aqlMethod;
      patch.aqlAcMethod = current.aqlAcMethod;
      patch.aqlSwitch = current.aqlSwitch;
    }
    // 旧 DOE 记录没有模型项快照：按当时的默认「全部效应 + 中心点曲率」恢复，
    // 不能继承用户当前页面的局部模型，否则历史结果会被静默改口径。
    if (a.kind === 'doe') {
      if (s.doeModelTerms === undefined) patch.doeModelTerms = null;
      if (s.doeIncludeCurvature === undefined) patch.doeIncludeCurvature = true;
    }
    if (a.kind === 'pareto' && !s.paretoData) patch.paretoShowDemo = s.paretoShowDemo ?? false;
    useApp.setState(patch);
    if (a.kind === 'spc' && usesWorksheet) syncSpecForActiveMeasurement();
    if (s.hypoTab) useApp.getState().setHypoTab(s.hypoTab);
    if (s.paretoView) useApp.getState().setParetoView(s.paretoView);
    if (s.doeView) useApp.getState().setDoeView(s.doeView);
    useApp.getState().goTo(a.kind);
    if (a.kind === 'aql') {
      useApp.getState().showToast('已打开 AQL；为保护连续判定，历史记录未覆盖当前抽样参数与批次状态');
    }
    sessionLog(a.kind === 'aql'
      ? `打开当前 AQL（历史摘要未回滚活跃流）· ${a.title}`
      : `恢复分析 ${a.title} · 数据集 ${a.datasetName}`);
    return true;
  },
}));

/** .qproj 恢复后重新加载分析记录（供 reload 前调用无意义,reload 会重建;此处供测试/内部） */
export function reloadAnalyses() {
  const saved = load();
  useAnalyses.setState({ saved, lastError: null });
  pruneAnalysisDataLibrary(saved);
}
