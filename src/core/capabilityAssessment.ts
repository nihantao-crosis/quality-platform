/**
 * 过程能力唯一判定器(P0-4):页面报告卡、保存分析、仪表盘、项目汇总与专项报告
 * 必须共用同一份评估结果——过程失控时,任何界面都不得以绿色「能力充足」作为总体状态。
 */
import type { VarModel } from './model';
import { evalRules, evalLimitedRules, DEFAULT_RULE_K, type NelsonRules, type NelsonRuleK } from './spc';
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

/** 能力分析口径的失控点数:位置图 + 离散图(与能力页 158–165 行历史逻辑一致)。
 * K 值需与 SPC 页/报告同源传入,否则同一数据两侧「受控性」结论会分裂。 */
export function countCapabilityViolations(M: VarModel, rules: NelsonRules, ruleK: NelsonRuleK = DEFAULT_RULE_K): number {
  const location = M.hasSubgroups
    ? evalRules(M.subs.map((s) => s.mean), M.xbarbar, (M.uclX - M.xbarbar) / 3, rules, ruleK)
    : evalRules(M.indiv, M.indMean, M.iSig, rules, ruleK);
  const dispersion = M.hasSubgroups
    ? evalLimitedRules(M.subs.map((s) => s.range), M.rbar, M.uclR, M.lclR, rules, ruleK)
    : evalLimitedRules(M.mr.slice(1) as number[], M.mrbar, M.mrUcl, 0, rules, ruleK);
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
    ? `控制图检出 ${spcViolations} 个失控点；Cpk=${nf(cpk, 2)} 只能描述现有样本，过程稳定前不得用于预测未来质量。`
    : capLevel === 'ok'
      ? `过程能力充足(Cpk=${nf(cpk, 2)}),按当前受控状态可满足规格要求。`
      : capLevel === 'warn'
        ? `过程能力临界(Cpk=${nf(cpk, 2)}),建议减少变异或居中过程后复评。`
        : `过程能力不足(Cpk=${nf(cpk, 2)}),预期将产出超差品——优先减少变异/对中,并加严检验。`;

  return { cpk, capVerdict: verdict, spcViolations, adP, n, level, status, headline };
}
