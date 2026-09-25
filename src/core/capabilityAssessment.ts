/**
 * 过程能力唯一判定器(P0-4):页面报告卡、保存分析、仪表盘、项目汇总与专项报告
 * 必须共用同一份评估结果——过程失控时,任何界面都不得以绿色「能力充足」作为总体状态。
 */
import type { VarModel } from './model';
import { evalRules, evalLimitedRules, expandSpcRuleItems, normalizeRuleK, type NelsonRules, type NelsonRuleK, type RuleViolation } from './spc';
import { resolveSpcStage, stagedRange, stagedXbar, type SpcStageResolution } from './stages';
import { prepareSpcData, type SpcRoleSelection } from './spcData';
import type { TextColumn } from './csv';
import { nf } from './basicMath';
import { spcSigmaIssue } from './advancedSpc';

export type AssessLevel = 'ok' | 'warn' | 'bad';

export interface CapabilityAssessment {
  cpk: number;
  capVerdict: 'sufficient' | 'marginal' | 'insufficient';
  spcViolations: number;
  adP: number | null;
  n: number;
  /** 总体等级:含稳定性与正态性;失控时永不为 ok。 */
  level: AssessLevel;
  /** 状态短语:供保存记录/汇总徽章使用。失控时不显示「能力充足」。 */
  status: string;
  /** 结论句:供报告卡与专项报告使用。 */
  headline: string;
}

// ---------- 通用报告 SPC 唯一评估器(v1.42.3,审计 P1) ----------
// 教训:v1.42.2 只修了无生产调用者的 textReport,四条真实导出链路(html/xlsx/word/ppt)
// 仍各自 evalRules 且只评位置图+硬编码 DEFAULT_RULES,同一报告可同时写「受控」与「不稳定」。
// 修复原则与 P0-4 一致:评估只在此计算一次,全部格式只消费结构化结果。

export interface SpcChartEvent {
  /** 分析单元空间的 0 基索引（X̄-R=子组；I-MR=观测，MR 本地图索引已 +1）。 */
  i: number;
  rule: number;
  desc: string;
  chart: string;
}

/** 通用报告的控制图族必须来自当前 SPC 配置，报告层不得按 VarModel 猜回 X̄-R。 */
export type SpcChartFamily = 'xbar-r' | 'xbar-s' | 'i-mr';

/**
 * 能力稳定性口径：单值模型只能是 I-MR；子组模型仅 X̄-S 显式切换到 S，其余（含 SPC 页选 I-MR）
 * 一律按 X̄-R——Cpk 用组内 σ（R̄/d₂），稳定性必须按子组图评估（UI-12：此口径有意保留，
 * 但与 SPC 页视图不同时必须经 capabilityStabilityCaliber 在文案中注明所用图型）。
 */
export function spcChartFamilyFor(M: VarModel, spcType: string): SpcChartFamily {
  return !M.hasSubgroups ? 'i-mr' : spcType === 'xbar-s' ? 'xbar-s' : 'xbar-r';
}

/**
 * SPC 视图口径（UI-12）：与 SPC 页当前 Shewhart 图型一致——子组数据选 I-MR 时按全部单值出 I/MR 图。
 * 质量总览的 SPC 告警/趋势图等「SPC 稳定性」消费者用本函数；能力稳定性仍用 spcChartFamilyFor。
 * EWMA/CUSUM/P/C 没有配对 Shewhart 图，回落到子组 X̄-R / 单值 I-MR 并由调用方注明图型。
 */
export function spcViewFamilyFor(M: VarModel, spcType: string): SpcChartFamily {
  return !M.hasSubgroups || spcType === 'i-mr' ? 'i-mr' : spcType === 'xbar-s' ? 'xbar-s' : 'xbar-r';
}

export const SPC_FAMILY_LABEL: Record<SpcChartFamily, string> = { 'xbar-r': 'X̄-R', 'xbar-s': 'X̄-S', 'i-mr': 'I-MR' };

const SPC_TYPE_LABEL: Record<string, string> = {
  'xbar-r': 'X̄-R', 'xbar-s': 'X̄-S', 'i-mr': 'I-MR', ewma: 'EWMA', cusum: 'CUSUM', p: 'P 图', c: 'C 图',
};

/** Shewhart 视图图型(X̄-R/X̄-S/I-MR)需按 SPC 模型解析；其余图型(EWMA/CUSUM/P/C)即 spcType 本身。 */
const SHEWHART_SPC_TYPES = new Set(['xbar-r', 'xbar-s', 'i-mr']);

/**
 * SPC 页当前实际显示的图型(UI-12)。Shewhart 图按 spcViewFamilyFor(SPC 模型, spcType)——单值数据选
 * X̄-R/X̄-S 时 SPC 页显示的是 I-MR；EWMA/CUSUM/P/C 原样返回 spcType。SPC 模型不可用(角色未配置)时回落 spcType。
 */
export function spcEffectiveViewType(spcModel: VarModel | null | undefined, spcType: string): string {
  return spcModel && SHEWHART_SPC_TYPES.has(spcType) ? spcViewFamilyFor(spcModel, spcType) : spcType;
}

/**
 * 能力稳定性口径披露（CORE-09 / UI-12）。能力分析（Minitab 同）不分阶段、固定按子组图评估稳定性；
 * 当 SPC 页当前视图与之不同（分阶段 X̄-R，或子组数据选了 I-MR/EWMA/CUSUM 等，或能力按常量子组而
 * SPC 为单值 I-MR）时，能力页、总览 Cpk 卡、能力记录与能力专项报告必须写明所用口径，否则同一数据
 * 两处结论互相矛盾且无从对账。视图一致时返回 null（不增加噪声）。
 *
 * 入参必须是 SPC 页**实际生效**的口径(fix2609k G20):
 * - spcViewType:spcEffectiveViewType(当前 SPC 模型, spcType)，不能用 spcType 字面值猜；
 * - spcStage:resolveSpcStage(...) 的结果，不能传原始 spcStageCol(残留/无效的阶段列不是「分阶段」)。
 */
export function capabilityStabilityCaliber(args: {
  capabilityFamily: SpcChartFamily;
  spcViewType: string;
  spcStage: SpcStageResolution | null | undefined;
}): { text: string; short: string } | null {
  const { capabilityFamily, spcViewType, spcStage } = args;
  const staged = spcStage?.state === 'active';
  const stageInvalid = spcStage?.state === 'invalid';
  const sameView = spcViewType === capabilityFamily;
  if (!staged && !stageInvalid && sameView) return null;
  const familyLabel = SPC_FAMILY_LABEL[capabilityFamily];
  const parts = [`稳定性按 ${familyLabel} 图${staged ? '、全局控制限（未分阶段）' : ''}评估`];
  if (staged) parts.push('能力分析不分阶段，与 SPC 页分阶段结论口径不同');
  if (stageInvalid) parts.push('SPC 分阶段未运行，能力稳定性按全局控制限评估');
  if (!sameView) parts.push(`与 SPC 页当前 ${SPC_TYPE_LABEL[spcViewType] ?? spcViewType} 视图口径不同`);
  return {
    text: parts.join('；'),
    short: `稳定性按 ${familyLabel} 图${staged ? '·全局限（未分阶段）' : stageInvalid ? '·全局限（分阶段未运行）' : ''}`,
  };
}

/**
 * 能力口径披露所需的「SPC 页实际生效口径」(fix2609k G20)。能力页、总览 Cpk 卡、能力记录、
 * 能力专项报告与通用导出(Modals)统一经此解析，与 SPC 页同源:
 * - spcViewType:按当前 SPC 模型解析的实际图型(单值数据选 X̄-R 时为 I-MR)；
 * - spcStage:resolveSpcStage 结果(残留/无效阶段列为 invalid，不是「分阶段」)。
 * SPC 角色未配置(prepared.error)时 SPC 页不出图:视图回落 spcType、阶段 off。
 */
export function spcStabilityView(args: {
  spcModel: VarModel | null | undefined;
  textCols: ReadonlyArray<{ name: string; values: string[] }>;
  spcType: string;
  spcStageCol: string | null | undefined;
}): { spcViewType: string; spcStage: SpcStageResolution } {
  const { spcModel, textCols, spcType, spcStageCol } = args;
  return {
    spcViewType: spcEffectiveViewType(spcModel, spcType),
    spcStage: spcModel
      ? resolveSpcStage({ stageColumn: spcStageCol, textCols, spcType, hasSubgroups: spcModel.hasSubgroups, pointCount: spcModel.k })
      : { state: 'off' },
  };
}

/** 同上，但从原始工作表 + SPC 数据角色解析(调用方手头没有 SPC prepared 时使用)。 */
export function spcStabilityViewFromRoles(
  rawModel: VarModel,
  rawTextCols: TextColumn[],
  roles: SpcRoleSelection,
  spcType: string,
  spcStageCol: string | null | undefined,
): { spcViewType: string; spcStage: SpcStageResolution } {
  const prepared = prepareSpcData(rawModel, rawTextCols, roles);
  return spcStabilityView({
    spcModel: prepared.error ? null : prepared.model,
    textCols: prepared.textCols,
    spcType,
    spcStageCol,
  });
}

/**
 * CORE-08:Shewhart 图(X̄-R/X̄-S/I-MR)的通用 σ̂ 守卫。σ̂ 非有限、为 0 或小于中心线的数值分辨率时
 * 控制限塌缩到中心线，任何 1 ulp 舍入都会被判超限——与 EWMA/CUSUM 同一原因文案，统一「不可判定」。
 * 同时检查模型 σ̂ 与判异实际使用的 (UCL−CL)/3 浮点表达式(与 evalRules 调用逐位同源)。
 */
export function shewhartSigmaIssue(M: VarModel, family: SpcChartFamily): string | null {
  const label = SPC_FAMILY_LABEL[family];
  if (family === 'i-mr') {
    return spcSigmaIssue(M.iSig, M.indMean, label) ?? spcSigmaIssue((M.iUcl - M.indMean) / 3, M.indMean, label);
  }
  const sigma = family === 'xbar-s' ? M.sigmaChartS : M.sigmaChart;
  const ucl = family === 'xbar-s' ? M.uclXs : M.uclX;
  return spcSigmaIssue(sigma / Math.sqrt(M.n), M.xbarbar, label)
    ?? spcSigmaIssue((ucl - M.xbarbar) / 3, M.xbarbar, label);
}

export interface SpcChartContext {
  data: number[];
  cl: number;
  ucl: number;
  lcl: number;
  /** 分阶段时与数据点对齐的段内限值（步进线）；未分阶段时缺省。 */
  clSeries?: number[];
  uclSeries?: number[];
  lclSeries?: number[];
  /** 分阶段时各段起点索引（首段除外）。 */
  stageBoundaries?: number[];
  /** 图标题/判异明细使用的图名：X̄、R、S、I、MR。 */
  label: string;
  /** 控制中心线标签：X̄、R̄、S̄、I、MR̄。 */
  clLabel: string;
  xIndexOffset: number;
}

/** 分阶段评估摘要（仅 stage.state==='active' 时存在）。 */
export interface SpcStageSummary {
  column: string;
  segmentCount: number;
  segmentLabels: string[];
}

export interface SpcAssessment {
  family: SpcChartFamily;
  /** CORE-08:非 null 时 σ̂ 不可判定(零变异/亚分辨率)，两图均未判异，结论行写「不可判定」。 */
  unavailableReason?: string | null;
  /** 分阶段时的段信息；null/缺省=按全局控制限评估。 */
  stage?: SpcStageSummary | null;
  location: SpcChartContext;
  dispersion: SpcChartContext;
  locationLabel: string;   // X̄ / I
  dispersionLabel: string; // R / MR
  /** 位置图内去重后的图表点数（兼容字段）。 */
  locationPoints: number;
  /** 离散图内去重后的图表点数（兼容字段）。 */
  dispersionPoints: number;
  /** 两张图内的失控点数之和；同一分析单元若在两图命中会累计两次。 */
  chartPointCount: number;
  /** 跨图去重后的分析单元名称：X̄-R 为子组，I-MR 为观测。 */
  analysisUnitLabel: '子组' | '观测';
  /** 位置+离散图映射到同一分析单元空间后的跨图去重数（MR 本地索引会先 +1）。 */
  uniqueAnalysisUnitCount: number;
  /** @deprecated 子组图下该名称不严谨；使用 uniqueAnalysisUnitCount。 */
  uniqueObservationCount: number;
  /** @deprecated 使用 uniqueAnalysisUnitCount；保留供既有调用兼容。 */
  uniquePointCount: number;
  stable: boolean;
  /**
   * 完整“图表点 × 准则”明细，而不是仅含每个窗口的触发终点。
   * 同一点命中两条准则时保留两行；已按映射后的分析单元号→图→准则排序。
   */
  events: SpcChartEvent[];
  /** 位置图高亮索引(供图表 violations 使用,图表点 0 基)。
   * 注意:Set 不可 JSON 序列化——本对象仅限同步消费,勿放入持久化/快照/IPC 载荷。 */
  locationViolIndexes: Set<number>;
  /** 离散图高亮索引（图内 0 基）。I-MR 中 MR[0] 对应原始观测 2，
   * 因此本集合保持 0 基供 MR 图直接使用；只有跨图去重/明细展示时才映射 +1。 */
  dispersionViolIndexes: Set<number>;
  /** 结论行:先判离散图(R/MR 失控时暂不解释位置图),两图全稳才写「受控」 */
  verdictLine: string;
}

interface RuleEvaluation {
  viol: Set<number>;
  list: RuleViolation[];
}

/**
 * SPC 判异唯一原语（CORE-09 / UI-12）：按图族 + 阶段口径评估位置图与离散图。
 * - family='i-mr' 在子组模型上按全部单值出 I/MR（与 SPC 页一致）；单值模型不得评 X̄ 图。
 * - stage.state='active' 时复用 stagedXbar/stagedRange 段内判异（与 SPC 页/保存记录/专项报告同源）；
 * - 非分阶段时先过 shewhartSigmaIssue(CORE-08):σ̂ 不可判定则不判异，返回 unavailableReason；
 *   'invalid' 时拒绝评估——调用方必须先展示「分阶段未运行：原因」，不得静默回退全局控制限。
 */
export function evaluateSpcChartRules(
  M: VarModel,
  rules: NelsonRules,
  ruleK: NelsonRuleK,
  family: SpcChartFamily,
  collectDetails: boolean,
  stage: SpcStageResolution | null = null,
  /** CORE-08 σ̂ 守卫；仅能力口径计数(countCapabilityViolations)关闭，保持能力判定口径不动。 */
  sigmaGuard = true,
): {
  normalizedK: NelsonRuleK;
  location: RuleEvaluation;
  dispersion: RuleEvaluation;
  staged: { x: ReturnType<typeof stagedXbar>; r: ReturnType<typeof stagedRange>; column: string } | null;
  /** CORE-08:非 null 时 σ̂ 不可判定，location/dispersion 为空评估；调用方须展示本原因而非「受控」。 */
  unavailableReason: string | null;
} {
  if (ruleK == null) throw new TypeError('SPC 判异评估必须显式传入 ruleK，不允许回落默认 K 值');
  const normalizedK = normalizeRuleK(ruleK);
  const options = { collectDetails };
  if (!M.hasSubgroups && family !== 'i-mr') {
    throw new Error(`SPC 图族 ${family} 与当前数据结构不兼容`);
  }
  if (stage?.state === 'invalid') throw new RangeError(`分阶段未运行：${stage.reason}`);
  if (stage?.state === 'active') {
    if (family !== 'xbar-r' || !M.hasSubgroups) throw new Error(`分阶段仅适用于子组 X̄-R，当前图族 ${family}`);
    const rows = M.subs.map((s) => s.vals);
    const x = stagedXbar(rows, stage.labels, rules, M.sigmaMethod, normalizedK, options);
    const r = stagedRange(rows, stage.labels, rules, M.sigmaMethod, normalizedK, options);
    return { normalizedK, location: x, dispersion: r, staged: { x, r, column: stage.column }, unavailableReason: null };
  }
  const unavailableReason = sigmaGuard ? shewhartSigmaIssue(M, family) : null;
  if (unavailableReason) {
    return {
      normalizedK,
      location: { viol: new Set<number>(), list: [] },
      dispersion: { viol: new Set<number>(), list: [] },
      staged: null,
      unavailableReason,
    };
  }
  const xUcl = family === 'xbar-s' ? M.uclXs : M.uclX;
  const location = family !== 'i-mr'
    ? evalRules(M.subs.map((s) => s.mean), M.xbarbar, (xUcl - M.xbarbar) / 3, rules, normalizedK, options)
    // σ 用 (UCL−CL)/3 而非 M.iSig:与页面(Spc.tsx)和保存摘要(analyses.ts)逐位同一浮点表达式。
    : evalRules(M.indiv, M.indMean, (M.iUcl - M.indMean) / 3, rules, normalizedK, options);
  const dispersion = family === 'xbar-s'
    ? evalLimitedRules(M.svals, M.sCl, M.uclS, M.lclS, rules, normalizedK, undefined, options)
    : family === 'xbar-r'
      ? evalLimitedRules(M.subs.map((s) => s.range), M.rCl, M.uclR, M.lclR, rules, normalizedK, undefined, options)
      : evalLimitedRules(M.mr.slice(1) as number[], M.mrbar, M.mrUcl, 0, rules, normalizedK, undefined, options);
  return { normalizedK, location, dispersion, staged: null, unavailableReason: null };
}

/** 通用报告(四种导出格式)共用的 SPC 判异评估。rules/ruleK 必须来自用户当前设置——
 * 任何调用点不得回落 DEFAULT_RULES,否则导出与页面口径分裂。 */
export function assessSpcCharts(
  M: VarModel,
  rules: NelsonRules,
  ruleK: NelsonRuleK,
  family: SpcChartFamily,
  /** 当前 SPC 配置的阶段口径（resolveSpcStage）；缺省=不分阶段。invalid 时抛错拒绝评估。 */
  stage: SpcStageResolution | null = null,
): SpcAssessment {
  // 公开 API 不允许静默回落标准 K：即使 JavaScript/反序列化调用绕过 TypeScript，
  // 漏传也必须立即暴露，而不是生成一份与用户当前设置不一致的报告。
  // evalRules 会自行规范化 K，明细展开也必须消费同一份规范化结果；
  // 否则 JS/旧快照传入空对象或非法字段时会出现“图 18 点、明细 10 行”。
  const { normalizedK, location, dispersion, staged, unavailableReason } = evaluateSpcChartRules(M, rules, ruleK, family, true, stage);
  const isIndividual = family === 'i-mr';
  const locationLabel = isIndividual ? 'I' : 'X̄';
  const dispersionLabel = family === 'xbar-s' ? 'S' : isIndividual ? 'MR' : 'R';
  // MR[j] 对应原始观测 j+2;点号空间统一到观测号后才能与 I 图去重
  const dispersionOffset = isIndividual ? 1 : 0;
  const dispersionPointSet = new Set([...dispersion.viol].map((i) => i + dispersionOffset));
  const unique = new Set([...location.viol, ...dispersionPointSet]);
  const chartPointCount = location.viol.size + dispersion.viol.size;
  // 明细必须与 SPC 页面走同一展开器:窗口型准则展开成逐点命中,否则「结论 N 点、明细 M 行」自相矛盾
  const events: SpcChartEvent[] = [
    ...expandSpcRuleItems(location.viol, location.list, locationLabel, normalizedK)
      .map((item) => ({ i: item.i, rule: item.rule, desc: item.desc, chart: locationLabel })),
    ...expandSpcRuleItems(dispersion.viol, dispersion.list, dispersionLabel, normalizedK)
      .map((item) => ({ i: item.i + dispersionOffset, rule: item.rule, desc: item.desc, chart: dispersionLabel })),
  ].sort((a, b) => a.i - b.i || a.chart.localeCompare(b.chart) || a.rule - b.rule);
  // σ̂ 不可判定时不得声称「受控」。
  const stable = unique.size === 0 && unavailableReason == null;
  const stageSummary: SpcStageSummary | null = staged
    ? { column: staged.column, segmentCount: staged.x.segments.length, segmentLabels: staged.x.segments.map((segment) => segment.label) }
    : null;
  // 分阶段口径必须写进结论行本身：通用报告四种格式都只渲染 verdictLine。
  const stageNote = stageSummary ? `（分阶段：按「${stageSummary.column}」${stageSummary.segmentCount} 段段内控制限判异）` : '';
  const verdictLine = unavailableReason
    ? `⚠ 不可判定：${unavailableReason}（控制限塌缩为一条线，未判异；请先确认量具分辨率或补测）`
    : (dispersionPointSet.size > 0
    ? `✗ ${dispersionLabel} 图检出 ${dispersionPointSet.size} 个异常点，过程变异尚未受控；暂不解释 ${locationLabel} 图，先调查离散异常`
    : stable
      ? '✓ 未检出失控点，过程受控（按当前启用的判异准则）'
      : `✗ ${locationLabel} 图检出 ${location.viol.size} 个失控点，存在特殊原因变异`) + stageNote;
  const stagedSeries = (result: NonNullable<typeof staged>['x']) => ({
    clSeries: result.clSeries, uclSeries: result.uclSeries, lclSeries: result.lclSeries, stageBoundaries: result.boundaries,
  });
  return {
    family,
    unavailableReason,
    stage: stageSummary,
    location: !isIndividual
      ? {
          data: M.subs.map((s) => s.mean), cl: M.xbarbar, ucl: family === 'xbar-s' ? M.uclXs : M.uclX, lcl: family === 'xbar-s' ? M.lclXs : M.lclX, label: 'X̄', clLabel: 'X̄', xIndexOffset: 0,
          ...(staged ? stagedSeries(staged.x) : {}),
        }
      : { data: M.indiv, cl: M.indMean, ucl: M.iUcl, lcl: M.iLcl, label: 'I', clLabel: 'I', xIndexOffset: 0 },
    dispersion: family === 'xbar-s'
      ? { data: M.svals, cl: M.sCl, ucl: M.uclS, lcl: M.lclS, label: 'S', clLabel: M.sigmaMethod === 'pooled' ? 'c₄σ̂' : 'S̄', xIndexOffset: 0 }
      : !isIndividual
        ? {
            data: M.subs.map((s) => s.range), cl: M.rCl, ucl: M.uclR, lcl: M.lclR, label: 'R', clLabel: M.sigmaMethod === 'pooled' ? 'd₂σ̂' : 'R̄', xIndexOffset: 0,
            ...(staged ? stagedSeries(staged.r) : {}),
          }
        : { data: M.mr.slice(1) as number[], cl: M.mrbar, ucl: M.mrUcl, lcl: 0, label: 'MR', clLabel: 'MR̄', xIndexOffset: 1 },
    locationLabel, dispersionLabel,
    locationPoints: location.viol.size,
    dispersionPoints: dispersion.viol.size,
    chartPointCount,
    analysisUnitLabel: isIndividual ? '观测' : '子组',
    uniqueAnalysisUnitCount: unique.size,
    uniqueObservationCount: unique.size,
    uniquePointCount: unique.size,
    stable,
    events,
    locationViolIndexes: location.viol,
    dispersionViolIndexes: dispersion.viol,
    verdictLine,
  };
}

/** 能力分析口径的失控点数:位置图 + 离散图(与能力页 158–165 行历史逻辑一致)。
 * K 值需与 SPC 页/报告同源传入,否则同一数据两侧「受控性」结论会分裂。 */
export function countCapabilityViolations(M: VarModel, rules: NelsonRules, ruleK: NelsonRuleK, family: SpcChartFamily): number {
  // 能力口径有意不分阶段、不按单值 I-MR 评子组数据（Cpk 用组内 σ）：与 SPC 视图不同时由
  // capabilityStabilityCaliber 在文案中披露。子组模型传 I-MR 属调用错误，保持显式拒绝。
  if (M.hasSubgroups && family === 'i-mr') throw new Error('能力稳定性不得按 I-MR 评估子组数据，请用 spcChartFamilyFor');
  // 页面/看板只需要整数；禁止为此构建、展开并排序整份报告明细。
  // σ̂ 守卫关闭:能力判定口径不动(零变异数据已由 capabilityInputError 拒绝)。
  const { location, dispersion } = evaluateSpcChartRules(M, rules, ruleK, family, false, null, false);
  return location.viol.size + dispersion.viol.size;
}

const worst = (a: AssessLevel, b: AssessLevel): AssessLevel =>
  a === 'bad' || b === 'bad' ? 'bad' : a === 'warn' || b === 'warn' ? 'warn' : 'ok';

export function assessCapability(args: {
  cpk: number;
  verdict: 'sufficient' | 'marginal' | 'insufficient';
  adP: number | null;
  n: number;
  spcViolations: number;
}): CapabilityAssessment {
  const { cpk, verdict, adP, n, spcViolations } = args;
  const capLevel: AssessLevel = verdict === 'sufficient' ? 'ok' : verdict === 'marginal' ? 'warn' : 'bad';
  const normPenalty: AssessLevel = adP != null && adP < 0.05 ? 'warn' : 'ok';
  const stableLevel: AssessLevel = spcViolations === 0 ? 'ok' : 'warn';
  const level = worst(worst(capLevel, normPenalty), stableLevel);

  const capText = verdict === 'sufficient' ? '能力充足' : verdict === 'marginal' ? '能力临界' : '能力不足';
  const status = spcViolations > 0 ? `过程不稳定 · ${capText}仅描述样本` : capText;
  const headline = spcViolations > 0
    ? `控制图检出 ${spcViolations} 个失控点（各图累计）；Cpk=${nf(cpk, 2)} 只能描述现有样本，过程稳定前不得用于预测未来质量。`
    : capLevel === 'ok'
      ? normPenalty !== 'ok'
        ? `过程能力充足(Cpk=${nf(cpk, 2)}),但数据显著偏离正态,指标可能失真——建议 Box-Cox 变换后复核再作判定。`
        : `过程能力充足(Cpk=${nf(cpk, 2)}),按当前受控状态可满足规格要求。`
      : capLevel === 'warn'
        ? `过程能力临界(Cpk=${nf(cpk, 2)}),建议减少变异或居中过程后复评。`
        : `过程能力不足(Cpk=${nf(cpk, 2)}),预期将产出超差品——优先减少变异/对中,并加严检验。`;

  return { cpk, capVerdict: verdict, spcViolations, adP, n, level, status, headline };
}
