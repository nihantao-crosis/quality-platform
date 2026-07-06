/**
 * 分阶段控制图 — 按阶段列（如 改进前/后、班次、批次）分段计算控制限。
 * 每个连续段独立估计中心线与 σ,判异在段内进行（Minitab Stages 语义）。
 */
import { CONTROL_CONSTANTS, evalRules, type NelsonRules, type RuleViolation } from './spc';

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
 * X̄ 图分阶段：rows 为子组矩阵,labels 与行对齐。
 * 每段：X̿ ± A2·R̄（段内估计）;段长 < 2 时限值退化为段均值（不判异）。
 */
export function stagedXbar(rows: number[][], labels: string[], rules: NelsonRules): StagedResult {
  const n = rows[0].length;
  const C = CONTROL_CONSTANTS[Math.max(2, Math.min(10, n))];
  return buildStaged(labels, rows.map((r) => r.reduce((a, b) => a + b, 0) / r.length), (seg) => {
    const segRows = rows.slice(seg.start, seg.end + 1);
    const means = segRows.map((r) => r.reduce((a, b) => a + b, 0) / r.length);
    const xbarbar = means.reduce((a, b) => a + b, 0) / means.length;
    const rbar = segRows.map((r) => Math.max(...r) - Math.min(...r)).reduce((a, b) => a + b, 0) / segRows.length;
    const half = C.A2 * rbar;
    return { cl: xbarbar, ucl: xbarbar + half, lcl: xbarbar - half, sigma: half / 3 || 1e-12 };
  }, rules);
}

/** R 图分阶段：UCL=D4·R̄,LCL=D3·R̄（段内估计） */
export function stagedRange(rows: number[][], labels: string[], rules: NelsonRules): StagedResult {
  const n = rows[0].length;
  const C = CONTROL_CONSTANTS[Math.max(2, Math.min(10, n))];
  return buildStaged(labels, rows.map((r) => Math.max(...r) - Math.min(...r)), (seg) => {
    const segRanges = rows.slice(seg.start, seg.end + 1).map((r) => Math.max(...r) - Math.min(...r));
    const rbar = segRanges.reduce((a, b) => a + b, 0) / segRanges.length;
    const ucl = C.D4 * rbar;
    const lcl = C.D3 * rbar;
    return { cl: rbar, ucl, lcl, sigma: (ucl - rbar) / 3 || 1e-12 };
  }, rules);
}

function buildStaged(
  labels: string[],
  points: number[],
  limitsOf: (seg: { start: number; end: number }) => { cl: number; ucl: number; lcl: number; sigma: number },
  rules: NelsonRules,
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
      const r = evalRules(segData, lim.cl, lim.sigma, rules);
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
