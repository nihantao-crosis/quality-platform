/**
 * 分阶段控制图 — 按阶段列（如 改进前/后、班次、批次）分段计算控制限。
 * 每个连续段独立估计中心线与 σ,判异在段内进行（Minitab Stages 语义）。
 */
import { CONTROL_CONSTANTS, DEFAULT_RULE_K, c4Of, evalLimitedRules, evalRules, type NelsonRuleK, type NelsonRules, type RuleViolation } from './spc';
import type { SpcSigmaMethod } from './model';
import { mean, rootMeanSquare, stdev } from './basicMath';

export interface StageSegment {
  label: string;
  start: number; // 起始点索引(含)
  end: number; // 结束点索引(含)
  cl: number;
  ucl: number;
  lcl: number;
  sigma: number;
}

export interface StagedResult {
  /** 与数据点对齐的分段限值序列（步进线） */
  clSeries: number[];
  uclSeries: number[];
  lclSeries: number[];
  segments: StageSegment[];
  /** 段起点索引（首段除外,用于画分界线） */
  boundaries: number[];
  viol: Set<number>;
  list: RuleViolation[];
}

/** 把阶段标签序列切成连续段 */
export function splitStages(labels: string[]): Array<{ label: string; start: number; end: number }> {
  const segs: Array<{ label: string; start: number; end: number }> = [];
  for (let i = 0; i < labels.length; i++) {
    const last = segs[segs.length - 1];
    if (last && last.label === labels[i]) last.end = i;
    else segs.push({ label: labels[i], start: i, end: i });
  }
  return segs;
}

/**
 * 校验阶段列是否足以独立估计控制限。
 *
 * 单点阶段会让中心线和控制限退化到该点本身，从而把任何异常“洗白”。因此阶段
 * 控制图至少需要两个连续阶段，且每个连续阶段至少包含两个子组/观测。
 */
export function stageValidationError(labels: string[], pointCount = labels.length, minPoints = 2): string | null {
  if (labels.length !== pointCount) return `阶段列有 ${labels.length} 行，但控制图有 ${pointCount} 个点`;
  const blank = labels.findIndex((label) => typeof label !== 'string' || label.trim() === '');
  if (blank >= 0) return `阶段列第 ${blank + 1} 行为空`;
  const segments = splitStages(labels);
  if (segments.length < 2) return '阶段列只有 1 个连续段';
  const short = segments.find((segment) => segment.end - segment.start + 1 < minPoints);
  if (short) {
    const ordinal = segments.indexOf(short) + 1;
    return `第 ${ordinal} 个连续阶段“${short.label}”只有 ${short.end - short.start + 1} 个点，至少需要 ${minPoints} 个`;
  }
  return null;
}

/**
 * X̄ 图分阶段：rows 为子组矩阵,labels 与行对齐。
 * 每段：X̿ ± A2·R̄（段内估计）;段长 < 2 时限值退化为段均值（不判异）。
 */
export function stagedXbar(
  rows: number[][],
  labels: string[],
  rules: NelsonRules,
  sigmaMethod: SpcSigmaMethod = 'classic',
  ruleK: Partial<NelsonRuleK> = DEFAULT_RULE_K,
): StagedResult {
  if (rows.length === 0 || rows[0].length < 2) throw new RangeError('分阶段 X̄ 图至少需要一个含 2 个测量值的子组');
  const validationError = stageValidationError(labels, rows.length);
  if (validationError) throw new RangeError(validationError);
  const n = rows[0].length;
  const C = CONTROL_CONSTANTS[Math.max(2, Math.min(10, n))];
  return buildStaged(labels, rows.map((row) => mean(row)), (seg) => {
    const segRows = rows.slice(seg.start, seg.end + 1);
    const means = segRows.map((row) => mean(row));
    const xbarbar = mean(means);
    const sigmaHat = segmentSigma(segRows, n, C, sigmaMethod);
    const half = (3 * sigmaHat) / Math.sqrt(n);
    return { cl: xbarbar, ucl: xbarbar + half, lcl: xbarbar - half, sigma: half / 3 };
  }, rules, false, ruleK);
}

/** R 图分阶段：CL=d2σ̂（classic=R̄），UCL/LCL=CL±3d3σ̂，LCL 截 0（段内估计） */
export function stagedRange(
  rows: number[][],
  labels: string[],
  rules: NelsonRules,
  sigmaMethod: SpcSigmaMethod = 'classic',
  ruleK: Partial<NelsonRuleK> = DEFAULT_RULE_K,
): StagedResult {
  if (rows.length === 0 || rows[0].length < 2) throw new RangeError('分阶段 R 图至少需要一个含 2 个测量值的子组');
  const validationError = stageValidationError(labels, rows.length);
  if (validationError) throw new RangeError(validationError);
  const n = rows[0].length;
  const C = CONTROL_CONSTANTS[Math.max(2, Math.min(10, n))];
  return buildStaged(labels, rows.map((r) => Math.max(...r) - Math.min(...r)), (seg) => {
    const segRows = rows.slice(seg.start, seg.end + 1);
    const segRanges = segRows.map((r) => Math.max(...r) - Math.min(...r));
    const rbar = mean(segRanges);
    const sigmaHat = segmentSigma(segRows, n, C, sigmaMethod);
    const cl = sigmaMethod === 'pooled' ? C.d2 * sigmaHat : rbar;
    const ucl = cl + 3 * C.d3 * sigmaHat;
    const lcl = Math.max(0, cl - 3 * C.d3 * sigmaHat);
    return { cl, ucl, lcl, sigma: C.d3 * sigmaHat };
  }, rules, true, ruleK);
}

/** 段内 σ̂：classic=R̄/d2（Minitab 标准 X̄-R 默认）；pooled=Sp/c4(d+1)（显式可选）。 */
function segmentSigma(segRows: number[][], n: number, C: (typeof CONTROL_CONSTANTS)[number], sigmaMethod: SpcSigmaMethod): number {
  if (sigmaMethod === 'classic') {
    const rbar = mean(segRows.map((row) => Math.max(...row) - Math.min(...row)));
    return rbar / C.d2;
  }
  const df = segRows.length * (n - 1);
  // 子组大小相同，因此 sqrt(mean(s_i²)) 与合并标准差完全等价；缩放 RMS
  // 避免先平方大/小量纲标准差导致不必要的溢出或下溢。
  return rootMeanSquare(segRows.map((row) => stdev(row))) / c4Of(df + 1);
}

function buildStaged(
  labels: string[],
  points: number[],
  limitsOf: (seg: { start: number; end: number }) => { cl: number; ucl: number; lcl: number; sigma: number },
  rules: NelsonRules,
  limited: boolean,
  ruleK: Partial<NelsonRuleK>,
): StagedResult {
  const raw = splitStages(labels);
  const clSeries = new Array<number>(points.length);
  const uclSeries = new Array<number>(points.length);
  const lclSeries = new Array<number>(points.length);
  const viol = new Set<number>();
  const list: RuleViolation[] = [];
  const segments: StageSegment[] = [];

  for (const seg of raw) {
    const lim = limitsOf(seg);
    for (let i = seg.start; i <= seg.end; i++) {
      clSeries[i] = lim.cl;
      uclSeries[i] = lim.ucl;
      lclSeries[i] = lim.lcl;
    }
    segments.push({ label: seg.label, start: seg.start, end: seg.end, ...lim });
    // 段内判异（段长 ≥ 2 才有意义）
    if (seg.end - seg.start >= 1) {
      const segData = points.slice(seg.start, seg.end + 1);
      const r = limited
        ? evalLimitedRules(segData, lim.cl, lim.ucl, lim.lcl, rules, ruleK)
        : evalRules(segData, lim.cl, lim.sigma, rules, ruleK);
      r.viol.forEach((i) => viol.add(i + seg.start));
      r.list.forEach((v) => list.push({ ...v, i: v.i + seg.start }));
    }
  }
  list.sort((a, b) => a.i - b.i);
  return {
    clSeries, uclSeries, lclSeries, segments,
    boundaries: raw.slice(1).map((s) => s.start),
    viol, list,
  };
}
