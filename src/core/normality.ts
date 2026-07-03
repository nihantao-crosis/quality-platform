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

export function andersonDarling(xs: number[]): AdResult {
  const n = xs.length;
  if (n < 8) throw new Error('Anderson-Darling 检验至少需要 8 个观测');
  const m = mean(xs);
  const s = stdev(xs, true);
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
  if (a2star >= 0.6) p = Math.exp(1.2937 - 5.709 * a2star + 0.0186 * a2star * a2star);
  else if (a2star > 0.34) p = Math.exp(0.9177 - 4.279 * a2star - 1.38 * a2star * a2star);
  else if (a2star > 0.2) p = 1 - Math.exp(-8.318 + 42.796 * a2star - 59.938 * a2star * a2star);
  else p = 1 - Math.exp(-13.436 + 101.14 * a2star - 223.73 * a2star * a2star);
  p = Math.min(1, Math.max(0, p));
  return { a2, a2star, p, normal: p >= 0.05, n };
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
