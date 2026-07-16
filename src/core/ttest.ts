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
  if (!Number.isFinite(mu0) || xs.some((value) => !Number.isFinite(value))) {
    throw new Error('单样本 t 检验只接受有限数值');
  }
  const m = mean(xs);
  const s = stdev(xs, true);
  const se = s / Math.sqrt(n);
  const df = n - 1;
  // 直接在 H0 的中心坐标中求均值差；先求大基准均值再相减会丢失低位。
  const diff = mean(xs.map((value) => value - mu0));
  // t 推断要求可估计的抽样误差。零标准误时 t/P 并非 ±∞/0，而是模型
  // 不可估计；明确阻断，避免把常数输入伪装成“高度显著”的抽样证据。
  if (!(se > 0) || !Number.isFinite(se) || xs.every((value) => value === xs[0])) {
    throw new Error('单样本 t 检验标准误为 0 或不可估计，无法计算 t 统计量与 P 值');
  }
  const t = diff / se;
  const p = tTwoSidedP(t, df);
  const tc = tInv(0.975, df);
  return { t, df, p, significant: p < 0.05, estimate: m, ciLow: m - tc * se, ciHigh: m + tc * se, se };
}

/** 双样本 t 检验（Welch）：H0 μ1 = μ2 */
export function twoSampleT(xs: number[], ys: number[]): TTestResult {
  if (xs.length < 2 || ys.length < 2) throw new Error('双样本 t 检验每组至少需要 2 个观测');
  if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) {
    throw new Error('双样本 t 检验只接受有限数值');
  }
  const v1 = stdev(xs, true) ** 2;
  const v2 = stdev(ys, true) ** 2;
  const n1 = xs.length;
  const n2 = ys.length;
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (!(se > 0) || !Number.isFinite(se)) {
    throw new Error('双样本 t 检验标准误为 0 或不可估计，无法计算 t 统计量与 P 值');
  }
  // Welch–Satterthwaite 自由度
  const df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  // 用共同原点比较两组，避免两个大而接近的均值相减时发生灾难性消减。
  const origin = xs[0];
  const diff = mean(xs.map((value) => value - origin))
    - mean(ys.map((value) => value - origin));
  const t = diff / se;
  const p = tTwoSidedP(t, df);
  const tc = tInv(0.975, df);
  return { t, df, p, significant: p < 0.05, estimate: diff, ciLow: diff - tc * se, ciHigh: diff + tc * se, se };
}
