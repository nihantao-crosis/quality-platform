/**
 * t 检验 — 单样本 / 双样本（Welch，不等方差）。
 * t 分布经不完全贝塔函数：双侧 P = I_{ν/(ν+t²)}(ν/2, 1/2)。
 */
import { mean, stdev, betai } from './basicMath';

/** t 分布 CDF（P(T ≤ t)，自由度 df） */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const p = 0.5 * betai(df / 2, 0.5, x);
  return t >= 0 ? 1 - p : p;
}

/** 双侧 P 值 */
export function tTwoSidedP(t: number, df: number): number {
  return betai(df / 2, 0.5, df / (df + t * t));
}

/** t 临界值（二分求逆,prob 为单侧累积概率,如 0.975） */
export function tInv(prob: number, df: number): number {
  let lo = 0;
  let hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < prob) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface TTestResult {
  t: number;
  df: number;
  p: number; // 双侧
  significant: boolean; // p < 0.05
  estimate: number; // 均值（单样本）或均值差（双样本）
  ciLow: number;
  ciHigh: number; // 95% CI
  se: number;
}

/** 单样本 t 检验：H0 μ = mu0 */
export function oneSampleT(xs: number[], mu0: number): TTestResult {
  const n = xs.length;
  if (n < 2) throw new Error('单样本 t 检验至少需要 2 个观测');
  const m = mean(xs);
  const s = stdev(xs, true);
  const se = s / Math.sqrt(n);
  const df = n - 1;
  const t = se === 0 ? 0 : (m - mu0) / se;
  const p = se === 0 ? 1 : tTwoSidedP(t, df);
  const tc = tInv(0.975, df);
  return { t, df, p, significant: p < 0.05, estimate: m, ciLow: m - tc * se, ciHigh: m + tc * se, se };
}

/** 双样本 t 检验（Welch）：H0 μ1 = μ2 */
export function twoSampleT(xs: number[], ys: number[]): TTestResult {
  if (xs.length < 2 || ys.length < 2) throw new Error('双样本 t 检验每组至少需要 2 个观测');
  const m1 = mean(xs);
  const m2 = mean(ys);
  const v1 = stdev(xs, true) ** 2;
  const v2 = stdev(ys, true) ** 2;
  const n1 = xs.length;
  const n2 = ys.length;
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  // Welch–Satterthwaite 自由度
  const df = se === 0 ? n1 + n2 - 2 : (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  const diff = m1 - m2;
  const t = se === 0 ? 0 : diff / se;
  const p = se === 0 ? 1 : tTwoSidedP(t, df);
  const tc = tInv(0.975, df);
  return { t, df, p, significant: p < 0.05, estimate: diff, ciLow: diff - tc * se, ciHigh: diff + tc * se, se };
}
