/**
 * 助手结论卡(对标 Minitab Assistant Report Card)— 纯函数,把统计输出翻译成
 * 红绿灯结论:一句人话 headline + 逐项体检 checks。各分析页用手头已算好的
 * 结果就地构建;不读 store,便于单测。
 */
import { nf, assessCapability } from '../core';

export type Level = 'ok' | 'warn' | 'bad';

export interface CheckItem {
  name: string;
  level: Level;
  note: string;
}

export interface ReportData {
  verdict: Level;
  headline: string;
  checks: CheckItem[];
}

export interface SpcReportData extends ReportData {
  /** 供 SPC 专项报告/导出复用；不依赖页面 DOM。 */
  details: {
    typeLabel: string;
    variableName?: string;
    dataRole?: string;
    readingOrder?: string;
    variationChartLabel?: string;
    variationStable?: boolean;
    /** 受影响点×准则的去重命中数，不是窗口型准则的触发事件数。 */
    pointRuleHitCount: number;
    /** @deprecated 向后兼容；语义同 pointRuleHitCount。 */
    signalCount: number;
    affectedPointCount: number;
  };
}

const worst = (...ls: Level[]): Level => (ls.includes('bad') ? 'bad' : ls.includes('warn') ? 'warn' : 'ok');

// ---------- SPC ----------
export function spcReport(args: {
  violList: { i: number; rule: number; desc: string; chartLabel?: string }[];
  k: number;            // 点数(子组/观测)
  n: number | number[]; // 子组大小；P 图可为每批实际检验数
  hasSubgroups: boolean;
  structure?: 'subgroup' | 'individual' | 'attribute-p' | 'attribute-c';
  typeLabel: string;    // 如 X̄-R
  /** 配对图的离散图信号；X̄-R 先判 R、X̄-S 先判 S、I-MR 先判 MR。 */
  variationChartLabel?: string | null;
  variationViolations?: { i: number; rule: number; desc: string; chartLabel?: string }[];
  variableName?: string;
  dataRole?: string;
}): SpcReportData {
  const { violList, k, n, hasSubgroups, typeLabel } = args;
  const sampleSizeText = Array.isArray(n)
    ? n.every((value) => value === n[0])
      ? String(n[0])
      : `${n.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY)}–${n.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY)}（逐批变化）`
    : String(n);
  const structure = args.structure ?? (hasSubgroups ? 'subgroup' : 'individual');
  // 按实际子组/观测点去重：同一点可在多张子图、多条准则上产生多条信号，
  // 但对现场调查而言仍是 1 个需追溯的实际点。
  const nViol = new Set(violList.map((v) => v.i)).size;
  const variationViol = args.variationViolations ?? [];
  const nVariationViol = new Set(variationViol.map((v) => v.i)).size;
  const byRule = new Map<number, number>();
  violList.forEach((v) => byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1));
  const ruleTxt = [...byRule.entries()].sort((a, b) => a[0] - b[0]).map(([r, c]) => `准则${r}×${c}`).join('、');

  const stab: CheckItem = nViol === 0
    ? { name: '过程稳定性', level: 'ok', note: `全部 ${k} 点均在控制限内,无模式异常` }
    : { name: '过程稳定性', level: 'bad', note: `${nViol} 个失控点(${violList.length} 个点-准则命中:${ruleTxt}),存在特殊原因变异` };
  const amount: CheckItem = k >= 20
    ? { name: '数据量', level: 'ok', note: `${k} 个点 ≥ 20,控制限估计可靠` }
    : { name: '数据量', level: 'warn', note: `仅 ${k} 个点,建议积累 ≥20 点后再固化控制限` };
  const struct: CheckItem = structure === 'attribute-p'
    ? { name: '抽样结构', level: 'ok', note: `每个样本检验 n=${sampleSizeText} 件，以不良率监控；控制限按每批实际样本量计算` }
    : structure === 'attribute-c'
      ? { name: '计数结构', level: 'ok', note: '按单位缺陷数监控；各单位大小与检验机会应保持一致' }
      : structure === 'subgroup'
        ? { name: '子组结构', level: 'ok', note: `子组大小 n=${sampleSizeText},组内变异估计合理` }
        : { name: '子组结构', level: 'warn', note: '单值数据,对小漂移的灵敏度低于子组图(可配合 EWMA/CUSUM)' };

  const variation: CheckItem | null = args.variationChartLabel
    ? nVariationViol === 0
      ? {
          name: `先判 ${args.variationChartLabel} 图`, level: 'ok',
          note: `${args.variationChartLabel} 图未检出特殊原因信号，过程变异受控；现在才可解释${args.variationChartLabel === 'MR' ? ' I ' : ' X̄ '}图`,
        }
      : {
          name: `先判 ${args.variationChartLabel} 图`, level: 'bad',
          note: `${args.variationChartLabel} 图有 ${nVariationViol} 个异常点，过程变异未受控；暂不解释均值/单值图，先调查离散异常`,
        }
    : null;
  const role: CheckItem | null = args.dataRole
    ? { name: '数据角色', level: 'ok', note: args.dataRole }
    : null;

  const checks = [variation, stab, amount, struct, role].filter((c): c is CheckItem => c != null);
  const headline = nVariationViol > 0 && args.variationChartLabel
    ? `${args.variationChartLabel} 图先检出 ${nVariationViol} 个异常点——过程变异未受控，暂停解释均值/单值图并先调查特殊原因。`
    : nViol === 0
      ? `${typeLabel} 显示过程统计受控——可继续监控,并可进行能力评估。`
      : `${typeLabel} 检测到 ${nViol} 个失控点——先调查并消除特殊原因,再做能力评估。`;

  return {
    verdict: worst(variation?.level ?? 'ok', stab.level, amount.level === 'warn' && nViol === 0 ? 'warn' : 'ok'),
    headline,
    checks,
    details: {
      typeLabel, variableName: args.variableName, dataRole: args.dataRole,
      readingOrder: args.variationChartLabel ? `先判 ${args.variationChartLabel} 图，再解释${args.variationChartLabel === 'MR' ? ' I ' : ' X̄ '}图` : undefined,
      variationChartLabel: args.variationChartLabel ?? undefined,
      variationStable: args.variationChartLabel ? nVariationViol === 0 : undefined,
      pointRuleHitCount: violList.length,
      signalCount: violList.length,
      affectedPointCount: nViol,
    },
  };
}

// ---------- 帕累托专项报告 ----------
export interface ParetoReportRow {
  name: string;
  count: number;
  percentage: number;
  cumulativePercentage: number;
  mergedOther: boolean;
}

export interface ParetoReportData {
  total: number;
  sourceCategoryCount: number;
  displayedCategoryCount: number;
  mergeOther: boolean;
  threshold: number;
  mergedCategoryCount: number;
  rows: ParetoReportRow[];
  topTwoShare: number;
  categoriesTo80Percent: number;
  followsParetoPattern: boolean;
  conclusion: string;
}

/** 页面、保存摘要和专项导出可共同使用的帕累托排序/累计/合并结果。 */
export function paretoReport(args: {
  rows: { name: string; count: number }[];
  mergeOther: boolean;
  threshold: number;
}): ParetoReportData {
  const sorted = args.rows
    .filter((r) => r.name.trim() !== '' && Number.isFinite(r.count) && r.count >= 0)
    .map((r) => ({ name: r.name, count: r.count }))
    .sort((a, b) => b.count - a.count);
  const total = sorted.reduce((sum, row) => sum + row.count, 0);
  const threshold = Math.max(0.5, Math.min(1, Number.isFinite(args.threshold) ? args.threshold : 0.95));
  let display = sorted;
  let mergedCategoryCount = 0;
  if (args.mergeOther && sorted.length > 3 && total > 0) {
    let cumulative = 0;
    let cut = sorted.length;
    for (let i = 0; i < sorted.length; i++) {
      cumulative += sorted[i].count;
      if (cumulative / total >= threshold) { cut = i + 1; break; }
    }
    if (sorted.length - cut >= 2) {
      mergedCategoryCount = sorted.length - cut;
      const kept = sorted.slice(0, cut);
      const tailCount = sorted.slice(cut).reduce((sum, row) => sum + row.count, 0);
      const existingOther = kept.filter((row) => row.name.trim() === '其他');
      // 源数据可能本来就有“其他”类别。合并尾部时必须收敛成唯一的“其他”，
      // 否则图上会出现两个同名柱且累计语义不明。
      display = [
        ...kept.filter((row) => row.name.trim() !== '其他'),
        { name: '其他', count: tailCount + existingOther.reduce((sum, row) => sum + row.count, 0) },
      ];
    }
  }
  let cumulative = 0;
  const rows = display.map((row) => {
    cumulative += row.count;
    return {
      ...row,
      percentage: total > 0 ? (row.count / total) * 100 : 0,
      cumulativePercentage: total > 0 ? (cumulative / total) * 100 : 0,
      mergedOther: row.name === '其他' && mergedCategoryCount > 0,
    };
  });
  const topN = Math.min(2, sorted.length);
  const topTwoShare = total > 0 ? (sorted.slice(0, topN).reduce((sum, row) => sum + row.count, 0) / total) * 100 : 0;
  let categoriesTo80Percent = 0;
  let run = 0;
  for (const row of sorted) {
    run += row.count;
    categoriesTo80Percent++;
    if (total === 0 || run / total >= 0.8) break;
  }
  const followsParetoPattern = sorted.length >= 5 && categoriesTo80Percent / sorted.length <= 0.25;
  const topNames = sorted.slice(0, topN).map((d) => `「${d.name}」`).join('与');
  const topRounded = Math.round(topTwoShare);
  const vitalPct = sorted.length ? Math.round((categoriesTo80Percent / sorted.length) * 100) : 0;
  const conclusion = topN < 2
    ? `${topNames || '当前类别'}占缺陷总数的 ${topRounded}%。`
    : followsParetoPattern
      ? `前 ${categoriesTo80Percent} 类(仅占 ${sorted.length} 类中的 ${vitalPct}%)即累计贡献 80% 的缺陷,呈典型帕累托「关键少数」集中——优先改善这几类可消除大部分不良。`
      : `前 ${topN} 类(${topNames})合计占 ${topRounded}%;需前 ${categoriesTo80Percent}/${sorted.length} 类才累计达 80%,集中度不足以称"80/20",建议扩大改善范围或细分类别。`;
  return {
    total, sourceCategoryCount: sorted.length, displayedCategoryCount: rows.length,
    mergeOther: args.mergeOther, threshold, mergedCategoryCount, rows,
    topTwoShare, categoriesTo80Percent, followsParetoPattern, conclusion,
  };
}

// ---------- 过程能力 ----------
export function capabilityReport(args: {
  cpk: number;
  verdict: 'sufficient' | 'marginal' | 'insufficient';
  adP: number | null;   // AD 检验 P 值;样本不足为 null
  n: number;            // 观测数
  spcViolations: number;
}): ReportData {
  const { cpk, verdict, adP, n, spcViolations } = args;
  // P0-4:总体等级与结论句来自唯一判定器,保证页面/保存记录/汇总/专项报告口径一致。
  const assessment = assessCapability({ cpk, verdict, adP, n, spcViolations });
  const capLevel: Level = verdict === 'sufficient' ? 'ok' : verdict === 'marginal' ? 'warn' : 'bad';
  const cap: CheckItem = {
    name: '过程能力',
    level: capLevel,
    note: `Cpk = ${nf(cpk, 2)}(${verdict === 'sufficient' ? '≥1.33 能力充足' : verdict === 'marginal' ? '1.00–1.33 临界,有改进空间' : '<1.00 不足,预期产生超差品'})`,
  };
  const norm: CheckItem = adP == null
    ? { name: '正态性', level: 'warn', note: '样本不足 8 个,无法做 AD 正态检验' }
    : adP >= 0.05
      ? { name: '正态性', level: 'ok', note: `AD 检验 P=${adP >= 0.999 ? '>0.999' : nf(adP, 3)} ≥ 0.05,未拒绝正态假设(现有样本未发现显著偏离正态的证据)` }
      : { name: '正态性', level: 'bad', note: `AD 检验 P=${nf(adP, 3)} < 0.05,偏离正态——Cpk 可能失真,建议 Box-Cox 变换` };
  const amount: CheckItem = n >= 100
    ? { name: '样本量', level: 'ok', note: `${n} 个观测 ≥ 100,能力估计稳定` }
    : n >= 30
      ? { name: '样本量', level: 'warn', note: `${n} 个观测(建议 ≥100),Cpk 置信区间较宽` }
      : { name: '样本量', level: 'bad', note: `仅 ${n} 个观测,能力估计不可靠` };
  const stable: CheckItem = spcViolations === 0
    ? { name: '过程稳定性', level: 'ok', note: '控制图无失控信号,能力指数有预测意义' }
    : { name: '过程稳定性', level: 'warn', note: `控制图有 ${spcViolations} 个失控点——过程不稳定时能力数值只描述过去,不能预测未来` };

  return {
    verdict: assessment.level,
    headline: assessment.headline,
    checks: [cap, norm, amount, stable],
  };
}

// ---------- Gage R&R ----------
export function gageReport(args: {
  grr: number;
  verdict: 'acceptable' | 'marginal' | 'unacceptable';
}): ReportData {
  const { grr, verdict } = args;
  const level: Level = verdict === 'acceptable' ? 'ok' : verdict === 'marginal' ? 'warn' : 'bad';
  return {
    verdict: level,
    headline: level === 'ok'
      ? `测量系统可接受(GRR=${nf(grr, 1)}% < 10%),测量数据可信,可用于过程分析与判定。`
      : level === 'warn'
        ? `测量系统有条件接受(GRR=${nf(grr, 1)}%,10–30%)——一般用途可用;关键特性建议改进量具或作业规范。`
        : `测量系统不可接受(GRR=${nf(grr, 1)}% > 30%)——先改进测量系统,当前数据不宜用于过程判定。`,
    checks: [
      {
        name: '测量系统变异 GRR%',
        level,
        note: `占研究变异 ${nf(grr, 1)}%(AIAG 判据:<10% 可接受,10–30% 临界,>30% 不可接受)`,
      },
      {
        name: '区分能力',
        level: level === 'ok' ? 'ok' : 'warn',
        note: level === 'ok' ? '测量变异小,足以区分部件差异' : '测量变异偏大,区分部件差异的能力受限',
      },
    ],
  };
}

// ---------- 单因子 ANOVA ----------
export function anovaReport(args: {
  p: number;
  significant: boolean;
  groups: { name: string; n: number }[];
  /** 宽表模式(各数值列作为一组):附加量纲一致性提醒 */
  wideCaution?: boolean;
}): ReportData {
  const { p, significant, groups, wideCaution } = args;
  const minN = Math.min(...groups.map((g) => g.n));
  const amount: CheckItem = minN >= 5
    ? { name: '各组样本量', level: 'ok', note: `${groups.length} 组,最小组 n=${minN} ≥ 5` }
    : { name: '各组样本量', level: 'warn', note: `最小组仅 n=${minN},检验功效有限,建议补样` };
  const sigTxt = p < 0.001 ? 'P<0.001' : `P=${nf(p, 3)}`;
  const checks: CheckItem[] = [
    { name: '显著性', level: 'ok', note: `${sigTxt}(α=0.05)` },
    amount,
  ];
  if (wideCaution) {
    checks.push({ name: '数据形态', level: 'warn', note: '宽表模式:各列须为同一响应量(同量纲)才可跨列比较均值' });
  }
  return {
    verdict: worst(amount.level, wideCaution ? 'warn' : 'ok'),
    headline: significant
      ? `组间均值差异显著(${sigTxt} < 0.05)——至少有一组与其他组不同,建议优先对比最高与最低的组找原因。`
      : `未发现显著的组间差异(${sigTxt} ≥ 0.05)——在当前数据量下,各组可视为同一总体。`,
    checks,
  };
}

// ---------- t 检验 ----------
export function tReport(args: {
  kind: 't1' | 't2';
  p: number;
  significant: boolean;
  n: number; // 有效样本量(t2 取较小组)
}): ReportData {
  const { kind, p, significant, n } = args;
  const sigTxt = p < 0.001 ? 'P<0.001' : `P=${nf(p, 3)}`;
  const amount: CheckItem = n >= 30
    ? { name: '样本量', level: 'ok', note: `n=${n} ≥ 30,对非正态较稳健` }
    : { name: '样本量', level: 'warn', note: `n=${n} < 30,小样本下结论依赖正态假设` };
  return {
    verdict: amount.level,
    headline: kind === 't1'
      ? significant
        ? `均值与目标存在显著差异(${sigTxt})——过程中心可能偏移,建议调整对中。`
        : `无证据表明均值偏离目标(${sigTxt})——过程中心可视为对准。`
      : significant
        ? `两组均值差异显著(${sigTxt},Welch 校正)——两组不可视为同一总体。`
        : `两组均值无显著差异(${sigTxt},Welch 校正)。`,
    checks: [{ name: '显著性', level: 'ok', note: `${sigTxt}(α=0.05)` }, amount],
  };
}

// ---------- 回归 ----------
export function regReport(args: {
  r2: number;
  p: number;
  significant: boolean;
  n: number;
}): ReportData {
  const { r2, p, significant, n } = args;
  const sigTxt = p < 0.001 ? 'P<0.001' : `P=${nf(p, 3)}`;
  const fit: CheckItem = r2 >= 0.7
    ? { name: '拟合度', level: 'ok', note: `R²=${nf(r2, 3)},X 解释了大部分 Y 的变异` }
    : r2 >= 0.3
      ? { name: '拟合度', level: 'warn', note: `R²=${nf(r2, 3)},解释力一般,可能还有其他影响因素` }
      : { name: '拟合度', level: 'bad', note: `R²=${nf(r2, 3)},线性解释力弱,不宜用此模型预测` };
  const amount: CheckItem = n >= 20
    ? { name: '样本量', level: 'ok', note: `n=${n} ≥ 20` }
    : { name: '样本量', level: 'warn', note: `n=${n} < 20,回归估计不稳定` };
  return {
    verdict: worst(significant ? 'ok' : 'warn', fit.level === 'bad' ? 'warn' : 'ok', amount.level),
    headline: significant
      ? `X 与 Y 存在显著线性关系(斜率 ${sigTxt}),R²=${nf(r2, 3)}${r2 >= 0.7 ? ',可用于预测与控制' : ',但解释力有限,预测需谨慎'}。`
      : `未发现显著线性关系(斜率 ${sigTxt})——X 的变化不足以解释 Y。`,
    checks: [{ name: '斜率显著性', level: significant ? 'ok' : 'warn', note: `${sigTxt}(α=0.05)` }, fit, amount],
  };
}
