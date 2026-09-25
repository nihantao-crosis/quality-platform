/**
 * 分析记录 — Minitab 式「项目工作台」骨架。
 * 每次「保存到项目」把当前分析连同其参数与所属数据集存为一条对象,
 * 可在仪表盘 / 项目管理器回看(切回数据集 + 还原参数 + 跳页),可删除,纳入 .qproj 备份。
 */
import { create } from 'zustand';
import { markLocalWrite, watchExternalWrite } from './crossTab';
import { errText, platform } from '../platform/adapter';
import {
  nf, capabilityInputError, computeCapability, evalRules, evalLimitedRules, prepareSpcData, computeGageRR, gageStudyData, GAGE_TOLERANCE,
  andersonDarling, assessCapability, countCapabilityViolations,
  prepareGageStudy, effectiveGageSelection, listGageCategoryColumns, resolveNumericColumn,
  oneWayAnova, oneSampleT, twoSampleT, linearRegression, anovaGroups, buildAnovaInput, resolveAnovaRoles, wideScaleDisparate, resolveAnovaMode, countAnovaPendingCells, isDoeAnalysisColumn, analyzeDoe, detectFactorial, analyzeFactorial, detectGeneralFactorial, analyzeGeneralFactorial, detectFractionalFactorial, analyzeFractionalFactorial, resolveDoeColumnsWide, MAX_FRACTIONAL_FACTORS, factorialModelTerms, factorialHierarchyClosure, resolveDoeBlockValues, plansByState, computeDescriptive,
  ewmaSeries, cusumSeries, stagedXbar, stagedRange, stageValidationError, normalizeSwitchStatus, spcChartFamilyFor,
  normalizeRuleK, assessGage, withSigmaMethod, MAX_SAVED_ANALYSES,
  type InspectionLevel, type AnovaMode, type AqlMethod, type AqlAcMethod, type AqlRegime, type GageStandard, type NelsonRules, type NelsonRuleK, type SwitchStatus, type SpcDataLayout, type SpcSigmaMethod,
} from '../core';
import { useApp, resolveGageTolerance, DEFAULT_SPC_RULES, GAGE_TOL_MEMORY_CAP, normalizeGageBatchCols, normalizeGageTolMemory, type SpcType, type DoeView, type DoeTab, type HypoTab, type ParetoView } from './appStore';
import { syncSpecForActiveMeasurement, useData, resolveCapabilityMeasurementData, isCapabilityWarningAcknowledged, type ParetoModel } from './dataStore';
import { loadFishboneState, saveFishboneState, type FishboneData } from './fishboneStore';
import { sessionLog } from './sessionLog';
import { projectStoreValidationError, registerProjectLifecycleHooks, spcPayloadContractError } from '../platform/project';
import { preserveCorruptStore } from './quarantine';

export type AnalysisKind = 'spc' | 'capability' | 'gagerr' | 'anova' | 'pareto' | 'doe' | 'aql' | 'summary';

export interface AnalysisSourceData {
  name: string;
  colNames: string[];
  rows: number[][];
  textCols: { name: string; values: string[]; sourceIndex?: number }[];
  pendingCells?: { row: number; col: number }[];
  isDemo?: boolean;
  /** 演示原型等场景的 I-MR 序列可能不同于行优先展平值，需一并保存。 */
  indivSeries?: number[];
}

export interface AnalysisSnapshot {
  snapshotVersion?: 2 | 3 | 4 | 5 | 6 | 7;
  spcType?: SpcType;
  spcRules?: NelsonRules;
  /** 判异准则可编辑 K 值;缺失即当时的 Nelson/Minitab 标准值(旧记录兼容)。 */
  spcRuleK?: NelsonRuleK;
  spcStageCol?: string | null;
  /** SPC σ 估计方法(批次720);缺失即旧记录=保存时的 R̄/d2 经典口径,回放固化 'classic'。 */
  spcSigmaMethod?: SpcSigmaMethod;
  /** ±1SL/±2SL 区带是否显示；旧记录缺失时按旧版是否分阶段迁移。 */
  spcShowZones?: boolean;
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
  /** 用户已确认的能力口径风险指纹；必须随记录固化，旧记录回落 null。 */
  capabilityWarningAcknowledgement?: string | null;
  gageUseReal?: boolean;
  /** 批次720-B:批量选中列与逐列公差记忆;缺失即旧记录(单列),回放清空批量态。 */
  gageBatchCols?: string[] | null;
  gageTolByCol?: Record<string, { mode: 'auto' | 'width' | 'upper' | 'lower' | 'none'; value: number | null }>;
  gageValueName?: string | null;
  gagePartName?: string | null;
  gageOperatorName?: string | null;
  /** v7：量具报告真实追溯字段，缺失时报告显示“未填写”。 */
  gageGaugeName?: string;
  gageReportBy?: string;
  gageStudyDate?: string;
  gageNotes?: string;
  gageRequestedReal?: boolean;
  gageSourceReal?: boolean;
  /** v1.40:MSA 过程公差口径与判定标准随快照固化;旧快照缺字段按保存时行为回放(双侧宽度/不设 + AIAG)。 */
  gageTolMode?: 'auto' | 'width' | 'upper' | 'lower' | 'none';
  gageTolValue?: number | null;
  gageStandard?: GageStandard;
  aqlLot?: number; aqlLevel?: InspectionLevel; aqlAQL?: number; aqlRegime?: AqlRegime; aqlMethod?: AqlMethod; aqlAcMethod?: AqlAcMethod;
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

/**
 * 读取去重工作表库。返回 null 表示库存在但读回失败(已隔离)——调用方必须把它与
 * 「库为空」区分开：STORE-01 中 prune 把隔离后的 {} 当作空库 removeItem,
 * 一次普通保存就删光了 40 条分析的全部快照。
 */
function readAnalysisDataLibrary(): AnalysisDataLibrary | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_ANALYSIS_DATA);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    const detail = projectStoreValidationError(LS_ANALYSIS_DATA, parsed);
    if (detail) {
      quarantineAnalysisStore(LS_ANALYSIS_DATA, raw, detail);
      return null;
    }
    return parsed as AnalysisDataLibrary;
  } catch {
    if (raw) quarantineAnalysisStore(LS_ANALYSIS_DATA, raw, 'JSON 解析失败或写入被截断');
    return null;
  }
}

function loadAnalysisDataLibrary(): AnalysisDataLibrary {
  return readAnalysisDataLibrary() ?? {};
}

/**
 * 写入一份工作表快照并返回去重键。retainKeys 是本次保存裁剪后仍被分析记录引用的旧键：
 * 新条目与这些旧条目一次落库，库在任何时刻都不超过 MAX_ANALYSIS_DATA_ENTRIES
 * (= MAX_SAVED_ANALYSES)。此前先写入第 41 条再 prune,读回校验判超限 → 整库隔离删除(STORE-01)。
 */
function storeAnalysisSourceData(data: AnalysisSourceData, retainKeys: ReadonlySet<string>): string | null {
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
  const next: AnalysisDataLibrary = {};
  for (const [existingKey, existing] of Object.entries(library)) {
    if (retainKeys.has(existingKey)) next[existingKey] = existing;
  }
  next[key] = data;
  try {
    localStorage.setItem(LS_ANALYSIS_DATA, JSON.stringify(next));
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

function referencedSourceDataKeys(saved: ReadonlyArray<SavedAnalysis>): Set<string> {
  return new Set(saved.map((analysis) => analysis.snapshot.sourceDataKey).filter((key): key is string => !!key));
}

function pruneAnalysisDataLibrary(saved: SavedAnalysis[]) {
  const keep = referencedSourceDataKeys(saved);
  const library = readAnalysisDataLibrary();
  // 读回失败(已隔离或隔离失败)时绝不能把 live 库当空表删掉；清理只是尽力而为。
  if (library === null) return;
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
  // 与 MSA 页同源:未手选的角色用可解释推荐补齐(716-R3 收口),否则页面按推荐算、
  // 保存记录按列序算,同一数据会得到两种研究结构。
  const effective = effectiveGageSelection(data.model, data.textCols,
    { value: app.gageValueName, part: app.gagePartName, operator: app.gageOperatorName });
  const prepared = prepareGageStudy(data.model, data.textCols, {
    ...effective,
    pendingCells: data.pendingCells,
  });
  return { requestedReal: !data.model.isDemo && app.gageUseReal, prepared, effective };
}

function attachWorksheetSnapshot(snapshot: AnalysisSnapshot, retainKeys: ReadonlySet<string>) {
  const data = useData.getState();
  const rows = data.model.subs.map((subgroup) => [...subgroup.vals]);
  const flattened = rows.flat();
  const hasDistinctIndiv = flattened.length !== data.model.indiv.length
    || flattened.some((value, index) => value !== data.model.indiv[index]);
  const sourceData: AnalysisSourceData = {
    name: data.model.name,
    colNames: [...data.model.colNames],
    rows,
    textCols: data.textCols.map((column) => ({ name: column.name, values: [...column.values], ...(Number.isInteger(column.sourceIndex) ? { sourceIndex: column.sourceIndex } : {}) })),
    pendingCells: data.pendingCells.map((cell) => ({ ...cell })),
    isDemo: data.model.isDemo || undefined,
    indivSeries: hasDistinctIndiv ? [...data.model.indiv] : undefined,
  };
  const key = storeAnalysisSourceData(sourceData, retainKeys);
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

// v1.42.3:判异展开器下沉至 core/spc(通用导出报告与页面共用),此处保持再导出以兼容既有调用方
import { expandSpcRuleItems, uniqueSpcPointCount } from '../core';
export { expandSpcRuleItems, uniqueSpcPointCount };
import type { SpcViolationItem } from '../core';
export type { SpcViolationItem };

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
      const SM = withSigmaMethod(prepared.model ?? M, app.spcSigmaMethod);
      const effType: SpcType = !SM.hasSubgroups && (app.spcType === 'xbar-r' || app.spcType === 'xbar-s')
        ? 'i-mr'
        : app.spcType;
      const rows = SM.subs.map((s) => s.vals);
      const means = SM.subs.map((s) => s.mean);
      const ruleViolations = (data: number[], cl: number, sigma: number) => {
        return evalRules(data, cl, sigma, app.spcRules, app.spcRuleK, { collectDetails: false }).viol;
      };
      const limitedViolations = (data: number[], cl: number, ucl: number | number[], lcl: number | number[], indexOffset = 0, sigmas?: number | number[]) => {
        // P/C 图限值有钳位:与 SPC 页/专项报告同口径直传真 σ(新增参数必须查全消费路径,716-R3 自查)
        const evaluated = evalLimitedRules(
          data, cl, ucl, lcl, app.spcRules, app.spcRuleK, sigmas, { collectDetails: false },
        );
        if (indexOffset === 0) return evaluated.viol;
        return new Set([...evaluated.viol].map((index) => index + indexOffset));
      };
      const mergeViolations = (...sets: ReadonlySet<number>[]): Set<number> => {
        const merged = new Set<number>();
        for (const set of sets) set.forEach((index) => merged.add(index));
        return merged;
      };
      let violations: Set<number>;
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
          const countOnly = { collectDetails: false } as const;
          const x = stagedXbar(rows, stageLabels, app.spcRules, app.spcSigmaMethod, app.spcRuleK, countOnly);
          const r = stagedRange(rows, stageLabels, app.spcRules, app.spcSigmaMethod, app.spcRuleK, countOnly);
          violations = mergeViolations(x.viol, r.viol);
          stageCount = x.segments.length;
        } else {
          violations = mergeViolations(
            ruleViolations(means, SM.xbarbar, (SM.uclX - SM.xbarbar) / 3),
            // 判异中心线与图表同口径(pooled 时 R 图 CL=d2σ̂ 而非 R̄,批次720)
            limitedViolations(SM.subs.map((s) => s.range), SM.rCl, SM.uclR, SM.lclR),
          );
        }
      } else if (effType === 'xbar-s') {
        violations = mergeViolations(
          ruleViolations(means, SM.xbarbar, (SM.uclXs - SM.xbarbar) / 3),
          limitedViolations(SM.svals, SM.sCl, SM.uclS, SM.lclS),
        );
      } else if (effType === 'i-mr') {
        violations = mergeViolations(
          ruleViolations(SM.indiv, SM.indMean, (SM.iUcl - SM.indMean) / 3),
          // MR[0] 无定义，图上第 1 个 MR 对应原始观测 2，故全局点索引 +1。
          limitedViolations(SM.mr.slice(1) as number[], SM.mrbar, SM.mrUcl, 0, 1),
        );
      } else if (effType === 'ewma') {
        const data = SM.hasSubgroups ? means : SM.indiv;
        const mu = SM.hasSubgroups ? SM.xbarbar : SM.indMean;
        const sigma = SM.hasSubgroups ? SM.sigmaChart / Math.sqrt(SM.n) : SM.iSig;
        const r = ewmaSeries(data, mu, sigma);
        violations = r.viol;
      } else if (effType === 'cusum') {
        const data = SM.hasSubgroups ? means : SM.indiv;
        const mu = SM.hasSubgroups ? SM.xbarbar : SM.indMean;
        const sigma = SM.hasSubgroups ? SM.sigmaChart / Math.sqrt(SM.n) : SM.iSig;
        const r = cusumSeries(data, mu, sigma, 0.5, SM.hasSubgroups ? 4 : 5);
        violations = r.viol;
      } else if (effType === 'p') {
        violations = limitedViolations(pModel.pprop, pModel.pbar, pModel.pUcls, pModel.pLcls, 0,
          pModel.pNs.map((n) => Math.sqrt(pModel.pbar * (1 - pModel.pbar) / n)));
      } else {
        violations = limitedViolations(cModel.cdata, cModel.cbar, cModel.cUcl, cModel.cLcl, 0, Math.sqrt(cModel.cbar));
      }

      // 不同准则、不同子图命中同一子组/观测时，依然只是 1 个实际失控点。
      const n = violations.size;
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
      // 保存的能力判定须以当前 SPC σ̂ 方法评估稳定性；Cpk 仍使用 CM.sigmaWithin。
      const capabilitySpcModel = withSigmaMethod(CM, app.spcSigmaMethod);
      const spec = {
        lsl: app.lslOn ? app.lsl : null, tgt: app.tgt, usl: app.uslOn ? app.usl : null,
      };
      const warningAcknowledged = isCapabilityWarningAcknowledged(
        M, dataState.textCols, CM, spec, app.capabilityWarningAcknowledgement,
      );
      const inputError = capabilityInputError(CM.all, CM.sigmaWithin, spec, { allowDistantSpec: warningAcknowledged });
      if (inputError) {
        return { kind, title: '过程能力分析', metric: inputError, status: '未分析', ...pick(WARN) };
      }
      const cap = computeCapability(CM.all, CM.sigmaWithin, spec, { allowDistantSpec: warningAcknowledged });
      // P0-4:与能力页/专项报告共用唯一判定器——过程失控时保存记录不得给绿色「能力充足」。
      const ad = CM.all.length >= 8 ? andersonDarling(CM.all) : null;
      const assessment = assessCapability({
        cpk: cap.cpk, verdict: cap.verdict, adP: ad ? ad.p : null, n: CM.all.length,
        spcViolations: countCapabilityViolations(capabilitySpcModel, app.spcRules, app.spcRuleK, spcChartFamilyFor(capabilitySpcModel, app.spcType)),
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
          ? computeGageRR(prepared.study.observations, resolveGageTolerance(app))
          : computeGageRR(gageStudyData(), { mode: 'width', value: GAGE_TOLERANCE });
        // 摘要判定随当前所选标准(工厂/AIAG);标准本身随快照固化,回放时按保存口径复现
        const assessment = assessGage(g, app.gageStandard);
        return {
          kind, title: `测量系统分析 Gage R&R${requestedReal ? '' : '(示例)'}`, metric: `GRR ${nf(g.totalGageRR, 1)}%`,
          status: requestedReal ? assessment.label : '演示',
          ...pick(requestedReal ? assessment.grade === 'good' ? OK : assessment.grade === 'warn' ? WARN : BAD : INFO),
        };
      } catch (error) {
        return { kind, title: '测量系统分析 Gage R&R', metric: (error as Error).message, status: '未分析', ...pick(WARN) };
      }
    }
    case 'anova': {
      const tab = app.hypoTab;
      if (tab === 'anova') {
        // 与 ANOVA 页共用实际角色和分组，真实数据不回落演示。
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
        const input = effMode ? buildAnovaInput(effMode, M.colNames, rows, textCols, app.anovaRespName, app.anovaFactorName) : null;
        const groups = input?.groups;
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
      // 真实数据:与 DOE 分析页共用 resolveDoeColumnsWide(同一选择/同一 7 因子上限,716-R3),
      // 保证「保存到项目的汇总卡」与分析页所见一致——旧 resolveDoeColumns 截到 4 因子会把
      // 2^(5-1) 的 E 因子静默丢弃,其效应冒充 A×B×C×D 出现在卡片上(自查确认 high)。
      const nc = M.colNames.length;
      if (nc >= 3) {
        const { factorIdx, respIdx } = resolveDoeColumnsWide(M.colNames, app.doeFactorCols, app.doeRespCol, MAX_FRACTIONAL_FACTORS);
        const facs = factorIdx.map((i) => ({ name: M.colNames[i], values: M.subs.map((s) => s.vals[i]) }));
        const resp = M.subs.map((s) => s.vals[respIdx]);
        // 检查顺序与分析页一致:先看因子结构、再看响应是否录入,避免页面与卡片给出不同诊断
        const blocks = resolveDoeBlockValues(M.colNames, M.subs.map((sub) => sub.vals), useData.getState().textCols);
        const det = facs.length <= 4 ? detectFactorial(facs, resp, { blocks }) : detectFractionalFactorial(facs, resp, { blocks });
        if (!det.ok) {
          // 716-R3:两水平识别失败时按一般全因子(2–5 水平)回落——分析页能出结果,
          // 保存卡不能还写「数据非因子设计」造成口径分裂。
          const gen = detectGeneralFactorial(facs, resp);
          if (gen.ok) {
            const pendingRows = useData.getState().pendingCells.filter((p) => p.col === respIdx).length;
            if (new Set(resp).size < 2 || pendingRows > 0) {
              return { kind, title: '实验设计 (DOE)', metric: pendingRows > 0 ? `尚有 ${pendingRows} 行未录入` : '响应尚未录入', status: '未分析', ...pick(WARN) };
            }
            const gr = analyzeGeneralFactorial(gen.design);
            const gSig = gr.rows.filter((row) => row.sig).map((row) => row.name);
            return {
              kind, title: `实验设计 · 一般全因子 ${gen.design.factorNames.length} 因子`,
              metric: gSig.length ? `${gSig.slice(0, 3).join('、')} 显著` : '无显著项',
              status: '已分析', ...pick(INFO),
            };
          }
          return { kind, title: '实验设计 (DOE)', metric: '数据非因子设计', status: '未分析', ...pick(WARN) };
        }
        const pendingRows = useData.getState().pendingCells.filter((p) => p.col === respIdx).length;
        if (new Set(resp).size < 2 || pendingRows > 0) {
          return { kind, title: '实验设计 (DOE)', metric: pendingRows > 0 ? `尚有 ${pendingRows} 行未录入` : '响应尚未录入', status: '未分析', ...pick(WARN) };
        }
        const allTerms = factorialModelTerms(det.design.factorNames);
        // 与分析页同口径:5 因子以上默认仅主效应+二因子交互入模(高阶交互与低阶项混杂)
        const availableTerms = det.design.factorNames.length > 4
          ? allTerms.filter((term) => term.split('×').length <= 2)
          : allTerms;
        const storedTerms = app.doeModelTerms?.filter((term) => availableTerms.includes(term));
        const selectedTerms = storedTerms?.length
          ? factorialHierarchyClosure(det.design.factorNames, storedTerms, availableTerms)
          : availableTerms;
        const fr = (det.design.factorNames.length <= 4 ? analyzeFactorial : analyzeFractionalFactorial)(det.design, {
          terms: selectedTerms,
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
        metric: `保存时 ${app.aqlRegime === 'per100' ? '计点' : '百分'} · ${plan.fullInspect ? 'N' : 'n'}=${plan.n} Ac=${plan.ac} Re=${plan.re}`,
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

/** retainKeys:本次保存后仍被其他分析记录引用的去重键(见 storeAnalysisSourceData)。 */
function snapshotOf(kind: AnalysisKind, retainKeys: ReadonlySet<string>): AnalysisSnapshot {
  const a = useApp.getState();
  const snap: AnalysisSnapshot = { snapshotVersion: 7 };
  if (kind === 'spc') {
    snap.spcType = a.spcType;
    snap.spcRules = { ...a.spcRules };
    snap.spcRuleK = { ...a.spcRuleK };
    snap.spcStageCol = a.spcStageCol;
    snap.spcSigmaMethod = a.spcSigmaMethod;
    snap.spcShowZones = a.spcShowZones;
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
    // 双审 P2:能力判定消费「当前判异准则」计数,必须随快照固化——否则历史回放用
    // 现在的 spcRules/spcRuleK 重算受控性,与保存时的卡片结论可分裂
    snap.spcRules = { ...a.spcRules };
    snap.spcRuleK = { ...a.spcRuleK };
    // 能力结论也依赖稳定性计数；不固化 σ̂ 方法会使回放的状态徽章改变。
    snap.spcSigmaMethod = a.spcSigmaMethod;
    // 稳定性计数经 spcChartFamilyFor(model, spcType) 取 R 图(X̄-R)或 S 图(X̄-S),
    // 两族失控数可不同；不固化 spcType 会让回放沿用当前页面口径,与保存卡结论翻转。
    snap.spcType = a.spcType;
    snap.lsl = a.lsl; snap.usl = a.usl; snap.tgt = a.tgt; snap.lslOn = a.lslOn; snap.uslOn = a.uslOn;
    snap.capabilityBins = a.capabilityBins;
    snap.capSubgroupMode = a.capSubgroupMode;
    snap.capSubgroupSize = a.capSubgroupSize;
    snap.capValueCol = a.capValueCol;
    snap.capSubgroupIdCol = a.capSubgroupIdCol;
    snap.capabilityWarningAcknowledgement = a.capabilityWarningAcknowledgement;
  }
  if (kind === 'gagerr') {
    // %公差直接依赖规格宽度；历史研究若只恢复列角色而不恢复当时的规格，
    // 同一组量具数据会在回看时得到不同结论。
    snap.lsl = a.lsl;
    snap.usl = a.usl;
    snap.lslOn = a.lslOn;
    snap.uslOn = a.uslOn;
    snap.gageUseReal = a.gageUseReal;
    const current = currentGageStudy();
    // 快照存「生效角色」而非原始 store 值(可能为 null 走推荐):推荐算法将来若调整,
    // 历史记录回放不能跟着变口径——保存时用的哪三列就固化哪三列。
    snap.gageValueName = a.gageValueName ?? current.effective.valueColumn;
    snap.gagePartName = a.gagePartName ?? current.effective.partColumn;
    snap.gageOperatorName = a.gageOperatorName ?? current.effective.operatorColumn;
    snap.gageGaugeName = a.gageGaugeName;
    snap.gageReportBy = a.gageReportBy;
    snap.gageStudyDate = a.gageStudyDate;
    snap.gageNotes = a.gageNotes;
    snap.gageRequestedReal = current.requestedReal;
    snap.gageSourceReal = current.requestedReal && current.prepared.ok;
    snap.gageTolMode = a.gageTolMode;
    snap.gageTolValue = a.gageTolValue;
    snap.gageStandard = a.gageStandard;
    snap.gageBatchCols = normalizeGageBatchCols(a.gageBatchCols);
    // 逐列公差记忆连同当前列的在用值一起固化,批量摘要回放不依赖此后的页面操作
    const toleranceMemory = normalizeGageTolMemory(a.gageTolByCol, [
      ...(snap.gageBatchCols ?? []), snap.gageValueName,
    ]);
    // 当前列必须作为最新条目保留；若先前已有同名键，先删再追加，避免 64 列截断时误删正在使用的公差。
    if (snap.gageValueName) {
      delete toleranceMemory[snap.gageValueName];
      toleranceMemory[snap.gageValueName] = { mode: a.gageTolMode, value: a.gageTolValue };
    }
    const protectedCols = new Set([...(snap.gageBatchCols ?? []), snap.gageValueName].filter((name): name is string => Boolean(name)));
    const entries = Object.entries(toleranceMemory);
    const selected = entries.filter(([name]) => protectedCols.has(name));
    const selectedNames = new Set(selected.map(([name]) => name));
    const remaining = Math.max(0, GAGE_TOL_MEMORY_CAP - selected.length);
    // slice(-0) 等价于 slice(0)，会在保护项恰好占满容量时反而把全部旧项带入快照。
    const recentOther = remaining > 0
      ? entries.filter(([name]) => !selectedNames.has(name)).slice(-remaining)
      : [];
    snap.gageTolByCol = normalizeGageTolMemory(
      Object.fromEntries([...recentOther, ...selected]),
      [...(snap.gageBatchCols ?? []), snap.gageValueName],
    );
  }
  if (kind === 'aql') {
    snap.aqlLot = a.aqlLot; snap.aqlLevel = a.aqlLevel; snap.aqlAQL = a.aqlAQL; snap.aqlRegime = a.aqlRegime;
    snap.aqlMethod = 'gb'; snap.aqlAcMethod = 'gb';
    // 标题/指标已经固化保存时的状态摘要；责任账本只保留在活跃 AQL store 中。
    // 历史卡不再复制整本 records，避免 40 个摘要把同一账本重复存储 40 次。
  }
  if (kind === 'doe') {
    snap.doeView = a.doeView;
    snap.doeTab = a.doeTab;
    snap.doeFactorCols = a.doeFactorCols;
    snap.doeRespCol = a.doeRespCol;
    if (a.doeModelTerms) {
      // Persist the exact same strong-hierarchy model shown on the page and
      // consumed by summaries/reports.  This also upgrades an old loaded
      // snapshot that selected an interaction without its parent terms.
      const data = useData.getState();
      const { factorIdx, respIdx } = resolveDoeColumnsWide(
        data.model.colNames, a.doeFactorCols, a.doeRespCol, MAX_FRACTIONAL_FACTORS,
      );
      const factors = factorIdx.map((index) => ({
        name: data.model.colNames[index],
        values: data.model.subs.map((subgroup) => subgroup.vals[index]),
      }));
      const response = data.model.subs.map((subgroup) => subgroup.vals[respIdx]);
      const blocks = resolveDoeBlockValues(
        data.model.colNames,
        data.model.subs.map((subgroup) => subgroup.vals),
        data.textCols,
      );
      const detected = factors.length <= 4
        ? detectFactorial(factors, response, { blocks })
        : detectFractionalFactorial(factors, response, { blocks });
      if (detected.ok) {
        const all = factorialModelTerms(detected.design.factorNames);
        const available = detected.design.factorNames.length > 4
          ? all.filter((term) => term.split('×').length <= 2)
          : all;
        snap.doeModelTerms = factorialHierarchyClosure(
          detected.design.factorNames,
          a.doeModelTerms,
          available,
        );
      } else {
        snap.doeModelTerms = [...a.doeModelTerms];
      }
    } else {
      snap.doeModelTerms = null;
    }
    snap.doeIncludeCurvature = a.doeIncludeCurvature;
  }
  if (kind === 'anova') {
    snap.hypoTab = a.hypoTab;
    snap.anovaMode = a.anovaMode;
    snap.anovaRespName = a.anovaRespName;
    snap.anovaFactorName = a.anovaFactorName;
    snap.anovaShowDemo = a.anovaShowDemo;
    // 固化保存时实际分析的列，不把跨模式失效的旧选择带入历史快照。
    if (a.hypoTab === 'anova') {
      const data = useData.getState();
      const rows = data.model.subs.map((sub) => sub.vals);
      const textCols = data.textCols.filter((column) => isDoeAnalysisColumn(column.name));
      const mode = data.model.isDemo ? null : resolveAnovaMode(
        a.anovaMode, data.model.colNames, rows, textCols.length, a.anovaRespName, a.anovaFactorName,
      );
      if (mode) {
        const roles = resolveAnovaRoles(mode, data.model.colNames, rows, textCols, a.anovaRespName, a.anovaFactorName);
        snap.anovaMode = mode;
        // 宽表没有单独的因子/响应列，保留原选择以便切回其他模式。
        if (mode !== 'wide') {
          snap.anovaRespName = roles.responseName;
          snap.anovaFactorName = roles.factorName;
        }
      }
    }
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
  if (analysisUsesWorksheet(kind, snap)) attachWorksheetSnapshot(snap, retainKeys);
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
    const encoded = JSON.stringify(saved);
    localStorage.setItem(LS_KEY, encoded);
    markLocalWrite(LS_KEY, encoded);
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

/** 生成不与已有记录碰撞的分析 ID(蜂群 P3-05:毫秒戳 + 4 位 base36 无唯一性校验,
 * 碰撞后 remove(id) 会一次删掉全部同 ID 记录、restore(id) 只取第一条)。 */
function nextAnalysisId(existing: ReadonlyArray<{ id: string }>): string {
  const taken = new Set(existing.map((a) => a.id));
  const uuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = uuid ? `a${uuid()}` : `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
  // 极端情况下退回带序号的确定性 ID,仍保证不碰撞
  let seq = 0;
  while (taken.has(`a${Date.now().toString(36)}-${seq}`)) seq += 1;
  return `a${Date.now().toString(36)}-${seq}`;
}

function worksheetSignature(
  rows: number[][], cols: string[], text: { name: string; values: string[] }[], pending: { row: number; col: number }[],
): string {
  return JSON.stringify({ rows, cols, text: text.map((tc) => ({ n: tc.name, v: tc.values })), pending });
}

type InactiveDatasetProbe =
  | { status: 'absent' }
  | { status: 'found'; sig: string }
  | { status: 'error'; message: string };

/**
 * STORE-02:读取非活动的同名数据集(最近列表完整条目优先；轻量条目或已挤出最近列表时读本机库)。
 * 读取失败必须如实返回 error,由调用方 fail-closed——无法确认内容就不能按名覆盖。
 * 不需要读本机库时同步返回：无需保全的回看保持同步完成(既有调用方/测试依赖这一点)。
 */
function probeInactiveDataset(name: string): InactiveDatasetProbe | Promise<InactiveDatasetProbe> {
  const recent = useData.getState().recents.find((entry) => entry.name === name);
  if (recent?.data) {
    const data = recent.data;
    return { status: 'found', sig: worksheetSignature(data.rows, data.colNames, data.textCols ?? [], data.pendingCells ?? []) };
  }
  const db = platform.datasetDb;
  if (!db) return { status: 'absent' };
  return readVaultDatasetSignature(db, name);
}

async function readVaultDatasetSignature(
  db: NonNullable<typeof platform.datasetDb>, name: string,
): Promise<InactiveDatasetProbe> {
  try {
    const json = await db.get(name);
    if (!json) return { status: 'absent' };
    const data = JSON.parse(json) as Partial<{
      name: string; rows: number[][]; colNames: string[];
      textCols: { name: string; values: string[] }[]; pendingCells: { row: number; col: number }[];
    }>;
    if (!data || data.name !== name || !Array.isArray(data.rows) || !Array.isArray(data.colNames)) {
      return { status: 'error', message: '本机库记录结构无效' };
    }
    return {
      status: 'found',
      sig: worksheetSignature(data.rows, data.colNames, Array.isArray(data.textCols) ? data.textCols : [], Array.isArray(data.pendingCells) ? data.pendingCells : []),
    };
  } catch (error) {
    return { status: 'error', message: errText(error) };
  }
}

type SingleSlot = 'p' | 'c' | 'pareto' | 'fishbone';

const SINGLE_SLOT_LABEL: Record<SingleSlot, string> = {
  p: 'P 图计数数据', c: 'C 图计数数据', pareto: '帕累托数据', fishbone: '鱼骨图',
};

/** P/C 计数、帕累托、鱼骨图各只有一个存储槽(不进最近列表/本机库)，回看会直接覆盖。 */
function singleSlotOfRecord(a: SavedAnalysis): SingleSlot | null {
  if (a.kind === 'spc' && a.snapshot.spcType === 'p') return 'p';
  if (a.kind === 'spc' && a.snapshot.spcType === 'c') return 'c';
  if (a.kind === 'pareto') return a.snapshot.paretoView === 'fishbone' ? 'fishbone' : 'pareto';
  return null;
}

/** 当前单槽内容签名；null = 内置示例/空态，没有需要保全的用户数据。 */
function currentSingleSlot(slot: SingleSlot): { sig: string; name: string } | null {
  const data = useData.getState();
  if (slot === 'p') {
    const m = data.pModel;
    return m.isDemo ? null : { sig: JSON.stringify(['p', m.name, m.pdef, m.pNs]), name: m.name };
  }
  if (slot === 'c') {
    const m = data.cModel;
    return m.isDemo ? null : { sig: JSON.stringify(['c', m.name, m.cdata]), name: m.name };
  }
  if (slot === 'pareto') {
    const m = data.paretoModel;
    return m ? { sig: JSON.stringify(['pareto', m.name, m.rows.map((row) => [row.name, row.count])]), name: m.name } : null;
  }
  const fishbone = loadFishboneState();
  if (fishbone.isDemo) return null;
  return {
    sig: JSON.stringify(['fishbone', fishbone.data.problem, fishbone.data.categories.map((category) => [category.name, category.causes])]),
    name: fishbone.data.problem || '未命名问题',
  };
}

/** 分析记录中该单槽数据的签名，口径与 currentSingleSlot 一致(演示记录不算用户数据的保存)。 */
function recordSingleSlotSignature(a: SavedAnalysis, slot: SingleSlot): string | null {
  if (singleSlotOfRecord(a) !== slot) return null;
  const s = a.snapshot;
  if (slot === 'p') {
    const p = s.pChartData;
    return p ? JSON.stringify(['p', p.name, p.counts, p.sampleSizes ?? p.counts.map(() => p.sampleSize)]) : null;
  }
  if (slot === 'c') return s.cChartData ? JSON.stringify(['c', s.cChartData.name, s.cChartData.counts]) : null;
  if (slot === 'pareto') {
    return s.paretoData ? JSON.stringify(['pareto', s.paretoData.name, s.paretoData.rows.map((row) => [row.name, row.count])]) : null;
  }
  if (!s.fishboneData || s.fishboneIsDemo === true) return null;
  return JSON.stringify(['fishbone', s.fishboneData.problem, s.fishboneData.categories.map((category) => [category.name, category.causes])]);
}

/**
 * STORE-03:回看单槽记录前，若当前内容是用户数据且未被任何分析记录保存(含本条)，
 * 先按对应视图自动存为一条分析记录——之后可随时回看恢复。记录已满时不挤掉旧记录，
 * 而是 fail-closed 取消回看；备份失败同样取消。返回 false 时当前数据未作任何更改。
 */
function preserveSingleSlotBeforeRestore(a: SavedAnalysis, slot: SingleSlot): boolean {
  const current = currentSingleSlot(slot);
  if (!current) return true;
  const saved = useAnalyses.getState().saved;
  if (saved.some((record) => recordSingleSlotSignature(record, slot) === current.sig)) return true;
  const label = `当前${SINGLE_SLOT_LABEL[slot]}「${current.name}」`;
  if (saved.length >= MAX_SAVED_ANALYSES) {
    const message = `${label}尚未保存到项目，且分析记录已达 ${MAX_SAVED_ANALYSES} 条上限，无法先自动备份；`
      + '为避免覆盖，已取消回看。请先删除不需要的旧记录后重试';
    useApp.getState().showToast(message);
    sessionLog(`无法回看分析 ${a.title} · ${message}`);
    return false;
  }
  const kind: AnalysisKind = slot === 'p' || slot === 'c' ? 'spc' : 'pareto';
  const app = useApp.getState();
  const previous = { spcType: app.spcType, paretoView: app.paretoView };
  // 备份按该槽对应的视图生成(与用户在该页点「保存到项目」同一路径)，生成后立即还原视图状态。
  useApp.setState(slot === 'p' || slot === 'c' ? { spcType: slot } : { paretoView: slot === 'fishbone' ? 'fishbone' : 'pareto' });
  let backup: SavedAnalysis | null;
  try {
    backup = saveAnalysisOfKind(kind);
  } catch {
    backup = null;
  } finally {
    useApp.setState(previous);
  }
  if (!backup) {
    const reason = useAnalyses.getState().lastError ?? '未能生成分析记录';
    const message = `${label}未能自动备份（${reason}）；为避免覆盖，已取消回看`;
    useApp.getState().showToast(message);
    sessionLog(`无法回看分析 ${a.title} · ${message}`);
    return false;
  }
  useApp.getState().showToast(`${label}尚未保存到项目，已先自动存为分析记录「${backup.title}」再回放；可随时回看恢复`);
  return true;
}

/**
 * 按指定分析类型保存一条记录(saveCurrent 与回看前自动备份共用)。
 * 去重工作表库与主索引的写入顺序见 STORE-01:库只保留裁剪后仍被引用的旧条目 + 新条目，
 * 主索引写失败时把库原样回滚，被挤出的最旧记录快照不会因一次失败保存而丢失。
 */
function saveAnalysisOfKind(kind: AnalysisKind): SavedAnalysis | null {
  useAnalyses.setState({ lastError: null });
  const previousSaved = useAnalyses.getState().saved;
  // 新记录插在最前，裁剪后最多保留 MAX_SAVED_ANALYSES - 1 条旧记录。
  const retainKeys = referencedSourceDataKeys(previousSaved.slice(0, MAX_SAVED_ANALYSES - 1));
  let previousLibraryRaw: string | null = null;
  try { previousLibraryRaw = localStorage.getItem(LS_ANALYSIS_DATA); } catch { /* 无法读取时按不存在处理 */ }
  const data = useData.getState();
  const app = useApp.getState();
  if (kind === 'summary') {
    const column = resolveNumericColumn(data.model, app.activeVar);
    const pending = data.pendingCells.filter((cell) => cell.col === column.index).length;
    if (pending > 0) {
      const lastError = `「${column.name}」仍有 ${pending} 个待录入单元格，描述性统计未运行，分析未保存`;
      useAnalyses.setState({ lastError });
      sessionLog(`保存分析失败 描述性统计 · ${lastError}`);
      return null;
    }
  }
  if (kind === 'anova' && app.hypoTab === 't2' && !data.model.isDemo && data.model.n < 2) {
    const lastError = '双样本 t 检验需要两个不同的数值列；当前真实工作表只有一列，分析未保存';
    useAnalyses.setState({ lastError });
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
    id: nextAnalysisId(useAnalyses.getState().saved),
    createdAt: Date.now(),
    datasetName,
    snapshot: snapshotOf(kind, retainKeys),
  };
  const saved = [entry, ...previousSaved].slice(0, MAX_SAVED_ANALYSES);
  if (!persist(saved)) {
    // snapshotOf 可能已改写去重库；主索引写入失败时整库回滚，回滚失败再退回按旧记录清理孤儿载荷。
    if (!rollbackAnalysisDataLibrary(previousLibraryRaw)) pruneAnalysisDataLibrary(previousSaved);
    const lastError = '本地存储空间不足，分析未保存；请先导出项目或删除旧记录后重试';
    useAnalyses.setState({ lastError });
    sessionLog(`保存分析失败 ${entry.title} · ${lastError}`);
    return null;
  }
  useAnalyses.setState({ saved, lastError: null });
  pruneAnalysisDataLibrary(saved);
  sessionLog(`保存分析 ${entry.title} · ${entry.metric} · 数据集 ${entry.datasetName}`);
  return entry;
}

function rollbackAnalysisDataLibrary(previousRaw: string | null): boolean {
  try {
    if (localStorage.getItem(LS_ANALYSIS_DATA) === previousRaw) return true;
    if (previousRaw == null) localStorage.removeItem(LS_ANALYSIS_DATA);
    else localStorage.setItem(LS_ANALYSIS_DATA, previousRaw);
    return true;
  } catch {
    return false;
  }
}

export const useAnalyses = create<AnalysesState>((set, get) => ({
  saved: load(),
  lastError: null,

  saveCurrent: () => {
    set({ lastError: null });
    const page = useApp.getState().page;
    if (!ANALYSIS_PAGES.includes(page as AnalysisKind)) return null;
    return saveAnalysisOfKind(page as AnalysisKind);
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
    // 导入/启动校验不是唯一信任边界：运行期内存或旧代码仍可能提供未经
    // load() 的记录。在 stash、计数序列复制和任何页面参数回放前重跑联合契约。
    const restorePayloadError = spcPayloadContractError(a.kind, a.snapshot);
    if (restorePayloadError) {
      useApp.getState().showToast(`回看失败：分析快照损坏（${restorePayloadError}）；当前数据未作更改，分析参数也未回放`);
      sessionLog(`无法回看分析 ${a.title} · 快照契约校验失败：${restorePayloadError}`);
      return false;
    }
    // 审查 P2:回看会替换活动数据集(可能同名,tick 名称守卫失守)——必须停掉模拟采集。
    // 复审 P3:此处曾手写 setMesRunning(false),且停在所有中止分支之前——那些分支明确
    // 宣称「当前数据未作更改」却把用户采集掐掉。现改为依赖下方 importMatrix/importCounts
    // 的 beginDatasetReplacement 单一闸门:只有真正替换数据时才停,且顺带清掉 interval。
    const s = a.snapshot;
    let restoredEmbeddedData = false;
    let stashedName: string | null = null; // 自审 P3:失败文案不能说「未作更改」——stash 已发生
    const usesWorksheet = analysisUsesWorksheet(a.kind, s);
    const source = usesWorksheet ? resolveSnapshotSourceData(s) : null;
    if (source) {
      // 双审 P1:回看快照会覆盖同名工作表的全部持久副本(qp-dataset-v1/recents/本机库)并清空撤销栈。
      // 若同名工作表已有后续编辑，先自动另存为副本再回放，否则用户数据不可恢复地丢失。
      const sourceSig = worksheetSignature(source.rows, source.colNames, source.textCols, source.pendingCells ?? []);
      const stashNotes: string[] = [];
      const stashedSuffix = () => (stashNotes.length ? `（此前已另存「${stashedName}」）` : '');
      /** 把当前活动表另存为副本；只有副本确认落盘/落库才返回 true,失败已提示并 fail-closed。 */
      const stashActive = async (label: string): Promise<boolean> => {
        const dataState = useData.getState();
        const current = dataState.model;
        // 蜂群 P1-01:副本必须**确认落盘**才能覆盖当前编辑。此前只取名字、丢弃
        // PersistOutcome,配额满时照样提示「已另存」并回放，用户的后续编辑静默丢失。
        const stash = dataState.saveAsCopy();
        if (!stash.outcome.persisted && (!stash.outcome.archiving || !stash.outcome.durability)) {
          useApp.getState().showToast(
            `${label}与快照内容不同，但副本未能保存（${stash.outcome.rejected ?? '存储空间不足'}）；`
            + `为避免丢失当前编辑，已取消回看${stashedSuffix()}。请先导出项目或清理存储后重试`,
          );
          return false;
        }
        if (!stash.outcome.persisted) {
          // archiving 只是「已发起」，不是数据安全证明。只有 SQLite put 真正
          // resolve 后才允许快照覆盖当前编辑；失败则 fail-closed。
          try {
            await stash.outcome.durability!;
          } catch (error) {
            useApp.getState().showToast(
              `${label}与快照内容不同，但副本「${stash.name}」未能写入本机数据库（${errText(error)}）；`
              + `为避免丢失当前编辑，已取消回看${stashedSuffix()}。当前编辑仍保留在内存中，请先导出项目或清理存储后重试`,
            );
            return false;
          }
          // 用户可能在等待大副本落库时又做了新操作。不得用旧 restore 请求
          // 覆盖这个更新的意图。
          const afterArchive = useData.getState();
          const archivedSig = worksheetSignature(
            afterArchive.model.subs.map((x) => x.vals), afterArchive.model.colNames,
            afterArchive.textCols, afterArchive.pendingCells,
          );
          const expectedCopySig = worksheetSignature(
            current.subs.map((x) => x.vals), current.colNames, dataState.textCols, dataState.pendingCells,
          );
          if (afterArchive.model.name !== stash.name || archivedSig !== expectedCopySig) {
            useApp.getState().showToast('副本已安全写入本机数据库，但等待期间工作表已发生新变更；为避免覆盖新操作，已取消本次回看');
            return false;
          }
        }
        stashedName = stash.name;
        stashNotes.push(`${label}与快照内容不同，已先安全另存为「${stash.name}」`);
        return true;
      };
      const initial = useData.getState();
      const initialSig = worksheetSignature(
        initial.model.subs.map((x) => x.vals), initial.model.colNames, initial.textCols, initial.pendingCells,
      );
      // 上一次副本写库失败后，活动表已是异名内存副本。再次点击回看时
      // 也必须继续 fail-closed，不能因「已异名」绕过安全副本闸门。
      const mustStash = initial.activeUnpersisted
        || (initial.model.name === source.name && initialSig !== sourceSig);
      if (mustStash && !(await stashActive(`当前「${initial.model.name}」`))) return false;
      // STORE-02:快照按名称回放会整条替换最近列表中的同名条目，并按名 upsert 本机库。
      // 同名数据集不是活动表(编辑后切到了别的表)时同样要保全：先载入它，再走同一副本闸门。
      if (initial.model.name !== source.name) {
        const probe = probeInactiveDataset(source.name);
        const target = probe instanceof Promise ? await probe : probe;
        if (target.status === 'error') {
          useApp.getState().showToast(
            `无法读取本机数据集库中的同名数据集「${source.name}」（${target.message}），不能确认其是否含有快照之后的编辑；`
            + `为避免覆盖，已取消回看${stashedSuffix()}`,
          );
          sessionLog(`无法回看分析 ${a.title} · 同名数据集 ${source.name} 读取失败`);
          return false;
        }
        if (target.status === 'found' && target.sig !== sourceSig) {
          const loaded = await useData.getState().loadRecent(source.name);
          if (!loaded || useData.getState().model.name !== source.name) {
            useApp.getState().showToast(
              `最近数据集「${source.name}」与快照内容不同，但未能载入以先行另存副本；为避免覆盖，已取消回看${stashedSuffix()}`,
            );
            return false;
          }
          if (!(await stashActive(`最近数据集「${source.name}」`))) return false;
        }
      }
      if (stashNotes.length) useApp.getState().showToast(`${stashNotes.join('；')}再回放`);
      const restoredRows = source.rows.map((row) => [...row]);
      try {
        useData.getState().importMatrix(
        source.name,
        [...source.colNames],
        restoredRows,
        source.textCols.map((column) => ({ name: column.name, values: [...column.values], ...(Number.isInteger(column.sourceIndex) ? { sourceIndex: column.sourceIndex } : {}) })),
        source.pendingCells?.map((cell) => ({ ...cell })) ?? [],
        {
          isDemo: source.isDemo === true,
          indivSeries: source.indivSeries?.map((value) => value),
          preserveSpecs: true,
        },
        );
      } catch (error) {
        // 复审 P3:导入写入口的有限性屏障会抛,而 SideNav/Dashboard 的 onClick 不接 promise,
        // 旧快照含非有限值时会变成未捕获 rejection
        useApp.getState().showToast(`回看失败:${errText(error)}${stashedName ? `；当前工作表已另存为「${stashedName}」` : "；当前数据未作更改"}`);
        return false;
      }
      restoredEmbeddedData = true;
    } else if (a.kind === 'spc' && s.spcType === 'p' && s.pChartData !== undefined) {
      if (!preserveSingleSlotBeforeRestore(a, 'p')) return false;
      // 自审 P3:此前只给 importMatrix 包了 try/catch,computePChart/computeCChart
      // 同样会抛(计数非法),而调用方 onClick 不接 promise → 未捕获 rejection
      try {
        useData.getState().importCounts(
          'p', s.pChartData.name, [...s.pChartData.counts],
          s.pChartData.sampleSizes ? [...s.pChartData.sampleSizes] : s.pChartData.sampleSize,
        );
      } catch (error) {
        useApp.getState().showToast(`回看失败:${errText(error)}${stashedName ? `；当前工作表已另存为「${stashedName}」` : "；当前数据未作更改"}`);
        return false;
      }
      restoredEmbeddedData = true;
    } else if (a.kind === 'spc' && s.spcType === 'c' && s.cChartData !== undefined) {
      if (!preserveSingleSlotBeforeRestore(a, 'c')) return false;
      try {
        useData.getState().importCounts('c', s.cChartData.name, [...s.cChartData.counts]);
      } catch (error) {
        useApp.getState().showToast(`回看失败:${errText(error)}${stashedName ? `；当前工作表已另存为「${stashedName}」` : "；当前数据未作更改"}`);
        return false;
      }
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
        // 先完整清除上一工作表的所有列绑定态，再回放目标快照；即使目标不是 SPC，
        // 也不能让上一表的 SPC/MSA/能力角色潜伏到新数据集。
        const loaded = await useData.getState().loadRecent(a.datasetName);
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
      if (!preserveSingleSlotBeforeRestore(a, s.paretoView === 'fishbone' ? 'fishbone' : 'pareto')) return false;
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
      'spcType', 'spcRules', 'spcStageCol', 'spcSigmaMethod', 'spcShowZones', 'spcDataLayout', 'spcValueCol', 'spcSubgroupCol',
      'lsl', 'usl', 'tgt', 'lslOn', 'uslOn', 'capabilityBins',
      'gageUseReal', 'gageValueName', 'gagePartName', 'gageOperatorName',
      'gageGaugeName', 'gageReportBy', 'gageStudyDate', 'gageNotes',
      'gageTolMode', 'gageTolValue', 'gageStandard', 'gageBatchCols', 'gageTolByCol',
      'doeView', 'doeTab', 'doeFactorCols', 'doeRespCol', 'doeModelTerms', 'doeIncludeCurvature',
      'hypoTab', 'anovaMode', 'anovaRespName', 'anovaFactorName', 'anovaShowDemo',
      't1ColName', 't1Mu0', 't2ColAName', 't2ColBName', 'regXName', 'regYName',
      'paretoView', 'paretoMergeOther', 'paretoThreshold', 'paretoShowDemo',
      'activeVar',
    ];
    for (const key of appKeys) if (s[key] !== undefined) patch[key] = s[key];
    // 能力子组口径随记录还原;旧记录无字段时回落默认「沿用 SPC 角色」,不继承当前页面配置。
    if (a.kind === 'capability') {
      // 旧能力快照未保存 σ̂ 方法，保存时唯一可用的控制图口径是 classic；
      // 不得泄漏当前页面的 pooled 选择而改写历史结论。
      if (s.spcSigmaMethod === undefined) patch.spcSigmaMethod = 'classic';
      // 同理，旧能力快照未固化 spcType：回落到子组图族的历史默认 X̄-R，
      // 不继承当前页面可能是的 X̄-S,否则回看会改写受控性结论。
      if (s.spcType === undefined) patch.spcType = 'xbar-r';
      patch.capSubgroupMode = s.capSubgroupMode ?? 'spc';
      patch.capSubgroupSize = typeof s.capSubgroupSize === 'number' && s.capSubgroupSize >= 2 && s.capSubgroupSize <= 10 ? Math.round(s.capSubgroupSize) : 5;
      patch.capValueCol = s.capValueCol ?? null;
      patch.capSubgroupIdCol = s.capSubgroupIdCol ?? null;
      patch.capabilityWarningAcknowledgement = s.capabilityWarningAcknowledgement ?? null;
    }
    // v1.40 以前的 gage 快照没有公差口径/判定标准:按保存时行为固化(双侧宽度或不设 + AIAG),不继承当前设置。
    if (a.kind === 'gagerr' && s.gageTolMode === undefined) {
      const width = s.lslOn && s.uslOn && typeof s.usl === 'number' && typeof s.lsl === 'number' ? s.usl - s.lsl : null;
      patch.gageTolMode = width != null && width > 0 ? 'width' : 'none';
      patch.gageTolValue = width != null && width > 0 ? width : null;
    }
    if (a.kind === 'gagerr' && s.gageStandard === undefined) patch.gageStandard = 'aiag';
    // 追溯字段属于单次研究。即便一个 v7 快照因损坏/手工编辑缺少个别字段，
    // 也必须逐字段回落为空，不能借用当前页面中另一份研究的信息。
    if (a.kind === 'gagerr') {
      const hasTraceFields = s.snapshotVersion === 7;
      patch.gageGaugeName = hasTraceFields && typeof s.gageGaugeName === 'string' ? s.gageGaugeName : '';
      patch.gageReportBy = hasTraceFields && typeof s.gageReportBy === 'string' ? s.gageReportBy : '';
      patch.gageStudyDate = hasTraceFields && typeof s.gageStudyDate === 'string' ? s.gageStudyDate : '';
      patch.gageNotes = hasTraceFields && typeof s.gageNotes === 'string' ? s.gageNotes : '';
    }
    // 批次720 以前的 gage 记录没有批量态:回放清空批量选择与逐列记忆,不继承当前页面
    if (a.kind === 'gagerr' && s.gageBatchCols === undefined) patch.gageBatchCols = null;
    if (a.kind === 'gagerr' && s.gageBatchCols !== undefined) patch.gageBatchCols = normalizeGageBatchCols(s.gageBatchCols);
    if (a.kind === 'gagerr') {
      patch.gageTolByCol = s.gageTolByCol === undefined
        ? normalizeGageTolMemory({})
        : normalizeGageTolMemory(s.gageTolByCol, [
          ...(normalizeGageBatchCols(s.gageBatchCols ?? null) ?? []),
          typeof patch.gageValueName === 'string' ? patch.gageValueName : s.gageValueName,
        ]);
    }
    // v1.30 以前的 SPC 记录没有规则/阶段快照：采用当时的产品默认，而非继承当前页面条件。
    // v1.43.0 起能力快照同样固化判异准则(受控性计数口径),回放规则与 SPC 一致。
    if ((a.kind === 'spc' || a.kind === 'capability') && !s.spcRules) patch.spcRules = { ...DEFAULT_SPC_RULES };
    if (a.kind === 'capability' && s.spcRules) patch.spcRules = { ...s.spcRules };
    // K 值随记录还原;旧记录无该字段时回到 Nelson/Minitab 标准值,不继承当前页面设置。
    if (a.kind === 'spc' || a.kind === 'capability') patch.spcRuleK = normalizeRuleK(s.spcRuleK);
    if (a.kind === 'spc' && s.spcStageCol === undefined) patch.spcStageCol = null;
    // 批次720 以前的 SPC 记录没有 σ 估计方法:保存时限值即 A2R̄/D3D4R̄(classic),回放固化该口径,不继承当前设置。
    if (a.kind === 'spc' && s.spcSigmaMethod === undefined) patch.spcSigmaMethod = 'classic';
    // 旧版非分阶段控制图原本就显示区带；分阶段图当时没有区带。单一布尔字段无法表达旧版
    // 每面板差异，按是否存在阶段列迁移是最接近保存时画面的确定性规则。
    if (a.kind === 'spc' && s.spcShowZones === undefined) {
      patch.spcShowZones = !((s.spcType ?? 'xbar-r') === 'xbar-r' && s.spcStageCol);
    }
    if (a.kind === 'spc' && s.spcDataLayout === undefined) {
      patch.spcDataLayout = 'auto';
      patch.spcValueCol = null;
      patch.spcSubgroupCol = null;
    }
    // 人工审核720已移除帕累托图面“合并其他”行为；历史快照也统一展开全部类别。
    if (a.kind === 'pareto') patch.paretoMergeOther = false;
    // AQL 参数、状态机与责任账本共同构成一条持续演进的活跃检验流。历史记录只用于
    // 导航和查看保存摘要，任何字段都不能写回，否则会把历史方案与当前转移序列串线。
    if (a.kind === 'aql') {
      const current = useApp.getState();
      patch.aqlLot = current.aqlLot;
      patch.aqlLevel = current.aqlLevel;
      patch.aqlAQL = current.aqlAQL;
      patch.aqlRegime = current.aqlRegime;
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
    // R3 前的旧 gage 快照未固化生效角色(null=保存当时的列序位置默认);回放时按基线口径
    // 显式解析成列名,不能让 null 落到新的推荐路径——推荐与位置默认不同会静默改口径。
    if (a.kind === 'gagerr' && (s.snapshotVersion == null || s.snapshotVersion < 6)
      && (s.gageValueName == null || s.gagePartName == null || s.gageOperatorName == null)) {
      const restored = useData.getState();
      const value = s.gageValueName ?? restored.model.colNames[0] ?? null;
      const cats = listGageCategoryColumns(restored.model, restored.textCols, value);
      patch.gageValueName = value;
      patch.gagePartName = s.gagePartName ?? cats[0]?.name ?? null;
      patch.gageOperatorName = s.gageOperatorName ?? cats[1]?.name ?? null;
    }
    useApp.setState(patch);
    if (a.kind === 'spc' && usesWorksheet) syncSpecForActiveMeasurement();
    if (s.hypoTab) useApp.getState().setHypoTab(s.hypoTab);
    if (s.paretoView) useApp.getState().setParetoView(s.paretoView);
    if (s.doeView) useApp.getState().setDoeView(s.doeView);
    useApp.getState().goTo(a.kind);
    const legacySpcType = s.spcType ?? 'xbar-r';
    if (a.kind === 'spc' && (s.snapshotVersion == null || s.snapshotVersion < 6)
      && (legacySpcType === 'xbar-r' || legacySpcType === 'xbar-s' || legacySpcType === 'i-mr')) {
      const message = '该旧版 SPC 记录已按修正后的 Minitab 控制图常数（d₂/d₃/c₄）重新计算；控制限可能与旧版有轻微差异';
      useApp.getState().showToast(message);
      sessionLog(`${message} · ${a.title}`);
    }
    if (a.kind === 'pareto' && s.paretoMergeOther === true) {
      const message = '旧版帕累托“合并其他”设置已停用；现按 Minitab 经典图展开全部类别';
      useApp.getState().showToast(message);
      sessionLog(`${message} · ${a.title}`);
    }
    if (a.kind === 'aql') {
      useApp.getState().showToast('已打开 AQL；为保护连续判定，历史记录未覆盖当前抽样参数与批次状态');
    }
    sessionLog(a.kind === 'aql'
      ? `打开当前 AQL（历史摘要未回滚活跃流）· ${a.title}`
      : `恢复分析 ${a.title} · 数据集 ${a.datasetName}`);
    return true;
  },
}));

// 盲审 P2:另一标签页保存/删除分析后重新水合,避免本标签用内存旧数组整键覆盖
watchExternalWrite(LS_KEY, () => {
  const fresh = load();
  const before = useAnalyses.getState().saved.length;
  useAnalyses.setState({ saved: fresh });
  if (fresh.length !== before) {
    try {
      useApp.getState().showToast(`另一窗口更新了已保存分析（${fresh.length} 条），已同步到本窗口`);
    } catch { /* 非浏览器环境忽略 */ }
  }
});

/** .qproj 恢复后重新加载分析记录（供 reload 前调用无意义,reload 会重建;此处供测试/内部） */
export function reloadAnalyses() {
  const saved = load();
  useAnalyses.setState({ saved, lastError: null });
  pruneAnalysisDataLibrary(saved);
}
