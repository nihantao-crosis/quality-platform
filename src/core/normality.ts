/**
 * 正态性检验 — Anderson-Darling（均值/方差未知情形，D'Agostino & Stephens 修正与 P 值）。
 */
import { mean, stdev, phi, invNorm } from './basicMath';

export interface AdResult {
  a2: number; // A² 统计量
  a2star: number; // 小样本修正 A*²
  p: number; // P 值
  normal: boolean; // p ≥ 0.05
  n: number;
}

export interface AdEvaluation {
  result: AdResult | null;
  /** result 为 null 时给用户的可操作说明。 */
  unavailableReason: string | null;
}

export function andersonDarling(xs: number[]): AdResult {
  const n = xs.length;
  if (n < 8) throw new Error('Anderson-Darling 检验至少需要 8 个观测');
  if (xs.some((value) => !Number.isFinite(value))) throw new Error('Anderson-Darling 检验只接受有限数值');
  const m = mean(xs);
  const s = stdev(xs, true);
  if (!(s > 0) || !Number.isFinite(s)) throw new Error('Anderson-Darling 检验要求数据具有正的有限标准差');
  const z = [...xs].sort((a, b) => a - b).map((x) => (x - m) / s);
  const EPS = 1e-12;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const Fi = Math.min(1 - EPS, Math.max(EPS, phi(z[i])));
    const Fni = Math.min(1 - EPS, Math.max(EPS, phi(z[n - 1 - i])));
    sum += (2 * i + 1) * (Math.log(Fi) + Math.log(1 - Fni));
  }
  const a2 = -n - sum / n;
  const a2star = a2 * (1 + 0.75 / n + 2.25 / (n * n));
  let p: number;
  if (a2star >= 0.6) {
    // Stephens 的尾部近似是开口向上的二次式；超出其有效区间后若继续外推，
    // 指数会在顶点后反向增大，甚至把极端非正态样本算成 p=1。顶点之后只保留
    // 最小尾概率，使 P 值随更大的 A*² 保持非增。
    const tailTurningPoint = 5.709 / (2 * 0.0186);
    const tailStatistic = Math.min(a2star, tailTurningPoint);
    p = Math.exp(1.2937 - 5.709 * tailStatistic + 0.0186 * tailStatistic * tailStatistic);
  }
  else if (a2star > 0.34) p = Math.exp(0.9177 - 4.279 * a2star - 1.38 * a2star * a2star);
  else if (a2star > 0.2) p = 1 - Math.exp(-8.318 + 42.796 * a2star - 59.938 * a2star * a2star);
  else p = 1 - Math.exp(-13.436 + 101.14 * a2star - 223.73 * a2star * a2star);
  p = Math.min(1, Math.max(0, p));
  return { a2, a2star, p, normal: p >= 0.05, n };
}

/**
 * 报告/UI 安全入口：AD 是可选诊断，不应因样本太少、常量数据或非有限值
 * 让整份报告导出失败。严格引擎入口 andersonDarling 仍保持抛错契约。
 */
export function evaluateAndersonDarling(xs: number[]): AdEvaluation {
  const n = xs.length;
  if (n < 8) {
    return { result: null, unavailableReason: `样本量不足 8 个（当前 ${n} 个），未执行 Anderson-Darling 正态性检验` };
  }
  if (xs.some((value) => !Number.isFinite(value))) {
    return { result: null, unavailableReason: '数据包含非有限值，正态性不可判定' };
  }
  const sd = stdev(xs, true);
  if (!(sd > 0) || !Number.isFinite(sd)) {
    return { result: null, unavailableReason: '数据无可估计变异，正态性不可判定' };
  }
  return { result: andersonDarling(xs), unavailableReason: null };
}

/** 正态概率图坐标：返回按值排序的 (x=观测值, z=期望正态分位数) */
export function probPlotPoints(xs: number[]): Array<{ x: number; z: number }> {
  const n = xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  // 中位秩（Benard 近似）
  return sorted.map((x, i) => {
    const pp = (i + 1 - 0.375) / (n + 0.25);
    return { x, z: invNorm(pp) };
  });
}
