/**
 * 过程能力唯一判定器(P0-4):页面报告卡、保存分析、仪表盘、项目汇总与专项报告
 * 必须共用同一份评估结果——过程失控时,任何界面都不得以绿色「能力充足」作为总体状态。
 */
import type { VarModel } from './model';
import { evalRules, evalLimitedRules, expandSpcRuleItems, normalizeRuleK, type NelsonRules, type NelsonRuleK } from './spc';
import { nf } from './basicMath';

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

export interface SpcAssessment {
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

function evaluateSpcChartRules(
  M: VarModel,
  rules: NelsonRules,
  ruleK: NelsonRuleK,
  collectDetails: boolean,
) {
  if (ruleK == null) throw new TypeError('SPC 判异评估必须显式传入 ruleK，不允许回落默认 K 值');
  const normalizedK = normalizeRuleK(ruleK);
  const options = { collectDetails };
  const location = M.hasSubgroups
    ? evalRules(M.subs.map((s) => s.mean), M.xbarbar, (M.uclX - M.xbarbar) / 3, rules, normalizedK, options)
    // σ 用 (UCL−CL)/3 而非 M.iSig:与页面(Spc.tsx)和保存摘要(analyses.ts)逐位同一浮点表达式。
    : evalRules(M.indiv, M.indMean, (M.iUcl - M.indMean) / 3, rules, normalizedK, options);
  const dispersion = M.hasSubgroups
    ? evalLimitedRules(M.subs.map((s) => s.range), M.rCl, M.uclR, M.lclR, rules, normalizedK, undefined, options)
    : evalLimitedRules(M.mr.slice(1) as number[], M.mrbar, M.mrUcl, 0, rules, normalizedK, undefined, options);
  return { normalizedK, location, dispersion };
}

/** 通用报告(四种导出格式)共用的 SPC 判异评估。rules/ruleK 必须来自用户当前设置——
 * 任何调用点不得回落 DEFAULT_RULES,否则导出与页面口径分裂。 */
export function assessSpcCharts(M: VarModel, rules: NelsonRules, ruleK: NelsonRuleK): SpcAssessment {
  // 公开 API 不允许静默回落标准 K：即使 JavaScript/反序列化调用绕过 TypeScript，
  // 漏传也必须立即暴露，而不是生成一份与用户当前设置不一致的报告。
  // evalRules 会自行规范化 K，明细展开也必须消费同一份规范化结果；
  // 否则 JS/旧快照传入空对象或非法字段时会出现“图 18 点、明细 10 行”。
  const { normalizedK, location, dispersion } = evaluateSpcChartRules(M, rules, ruleK, true);
  const locationLabel = M.hasSubgroups ? 'X̄' : 'I';
  const dispersionLabel = M.hasSubgroups ? 'R' : 'MR';
  // MR[j] 对应原始观测 j+2;点号空间统一到观测号后才能与 I 图去重
  const dispersionOffset = M.hasSubgroups ? 0 : 1;
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
  const stable = unique.size === 0;
  const verdictLine = dispersionPointSet.size > 0
    ? `✗ ${dispersionLabel} 图检出 ${dispersionPointSet.size} 个异常点，过程变异尚未受控；暂不解释 ${locationLabel} 图，先调查离散异常`
    : stable
      ? '✓ 未检出失控点，过程受控（按当前启用的判异准则）'
      : `✗ ${locationLabel} 图检出 ${location.viol.size} 个失控点，存在特殊原因变异`;
  return {
    locationLabel, dispersionLabel,
    locationPoints: location.viol.size,
    dispersionPoints: dispersion.viol.size,
    chartPointCount,
    analysisUnitLabel: M.hasSubgroups ? '子组' : '观测',
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
export function countCapabilityViolations(M: VarModel, rules: NelsonRules, ruleK: NelsonRuleK): number {
  // 页面/看板只需要整数；禁止为此构建、展开并排序整份报告明细。
  const { location, dispersion } = evaluateSpcChartRules(M, rules, ruleK, false);
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
      ? `过程能力充足(Cpk=${nf(cpk, 2)}),按当前受控状态可满足规格要求。`
      : capLevel === 'warn'
        ? `过程能力临界(Cpk=${nf(cpk, 2)}),建议减少变异或居中过程后复评。`
        : `过程能力不足(Cpk=${nf(cpk, 2)}),预期将产出超差品——优先减少变异/对中,并加严检验。`;

  return { cpk, capVerdict: verdict, spcViolations, adP, n, level, status, headline };
}
