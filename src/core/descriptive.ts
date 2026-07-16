/**
 * 描述性统计（对标 Minitab Basic Statistics → Display / Graphical Summary）。
 * 纯函数,复用 basicMath/normality/ttest 中已有的数值零件。
 */
import { mean, stdev, median, quantile, lgamma } from './basicMath';
import { andersonDarling, type AdResult } from './normality';
import { tInv } from './ttest';

export interface Descriptive {
  n: number;
  mean: number;
  seMean: number;       // 均值标准误 = s/√n
  stdev: number;        // 样本标准差
  variance: number;
  cv: number | null;    // 变异系数 % = 100·s/|x̄|；均值为 0 时未定义
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  range: number;
  iqr: number;
  skewness: number;     // 样本偏度 g1（含小样本校正）
  kurtosis: number;     // 样本超额峰度 g2（含小样本校正）
  sum: number;
  ad: AdResult;         // Anderson-Darling 正态检验（n<8 时为占位,见 adAvailable）
  adAvailable: boolean; // AD 检验需 n≥8
  adUnavailableReason: string | null;
  ciMean: [number, number];    // 均值 95% 置信区间（t）
  ciMedian: [number, number];  // 中位数 95% 置信区间（次序统计）
  ciStdev: [number, number];   // 标准差 95% 置信区间（精确卡方分位）
}

/** 正则化下不完全伽马 P(a,x)，用于 χ² CDF。 */
function regularizedGammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const EPS = 1e-14;
  const MAX_ITER = 300;
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    let ap = a;
    for (let i = 1; i <= MAX_ITER; i++) {
      ap += 1;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) <= Math.abs(sum) * EPS) break;
    }
    return Math.min(1, Math.max(0, sum * Math.exp(-x + a * Math.log(x) - lgamma(a))));
  }

  // Lentz 连分式计算 Q(a,x)，再取 P=1-Q。
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / Math.max(FPMIN, b);
  let h = d;
  for (let i = 1; i <= MAX_ITER; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) <= EPS) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
  return Math.min(1, Math.max(0, 1 - q));
}

/** χ²(p,k) 分位数：单调括界后二分，覆盖 k=1 的小样本尾部。 */
function chi2Inv(p: number, k: number): number {
  if (!(p > 0 && p < 1) || !(k > 0)) throw new RangeError('卡方分位要求 0<p<1 且自由度>0');
  const cdf = (x: number) => regularizedGammaP(k / 2, x / 2);
  let lo = 0;
  let hi = Math.max(1, k);
  while (cdf(hi) < p) hi *= 2;
  for (let i = 0; i < 160; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 中位数的分布无关 95% CI:由二项分布正态近似取次序统计量。 */
function medianCI(sorted: number[]): [number, number] {
  const n = sorted.length;
  // 排名 j..k(1 基),约等于 n/2 ± 1.96·√n/2
  const half = 1.959963984540054 * Math.sqrt(n) / 2;
  let lo = Math.floor(n / 2 - half);
  let hi = Math.ceil(n / 2 + half) + 1;
  lo = Math.max(1, lo);
  hi = Math.min(n, hi);
  return [sorted[lo - 1], sorted[hi - 1]];
}

export function computeDescriptive(raw: number[]): Descriptive {
  const xs = raw.filter(Number.isFinite);
  const n = xs.length;
  if (n < 2) throw new Error('描述性统计至少需要 2 个有效观测值');
  const sorted = [...xs].sort((a, b) => a - b);
  const m = mean(xs);
  const s = stdev(xs); // 样本标准差(n−1)
  const variance = s * s;
  const seMean = s / Math.sqrt(n);

  // 偏度 g1、超额峰度 g2(含无偏小样本校正,与 Minitab 一致)
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of xs) { const d = x - m; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
  m2 /= n; m3 /= n; m4 /= n;
  const sPop = Math.sqrt(m2);
  const b1 = sPop > 0 ? m3 / (sPop ** 3) : 0;
  const b2 = m2 > 0 ? m4 / (m2 * m2) : 0;
  const skewness = n > 2 ? (Math.sqrt(n * (n - 1)) / (n - 2)) * b1 : 0;
  const kurtosis = n > 3
    ? ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * (b2 - 3) + 6)
    : b2 - 3;

  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const med = median(sorted);
  const min = sorted[0];
  const max = sorted[n - 1];
  const sum = xs.reduce((a, b) => a + b, 0);

  // 均值 95% CI(t)
  const tc = tInv(0.975, n - 1);
  const ciMean: [number, number] = [m - tc * seMean, m + tc * seMean];
  // 标准差 95% CI(卡方)
  const chiLo = chi2Inv(0.975, n - 1);
  const chiHi = chi2Inv(0.025, n - 1);
  const ciStdev: [number, number] = [
    s * Math.sqrt((n - 1) / chiLo),
    s * Math.sqrt((n - 1) / chiHi),
  ];

  const adUnavailableReason = n < 8
    ? `Anderson-Darling 正态检验至少需要 8 个观测，当前仅 ${n} 个`
    : s === 0 ? '数据标准差为 0，正态性检验不可估计' : null;
  const adAvailable = adUnavailableReason == null;
  const ad: AdResult = adAvailable
    ? andersonDarling(xs)
    : { a2: NaN, a2star: NaN, p: NaN, normal: true, n };

  return {
    n, mean: m, seMean, stdev: s, variance,
    cv: m !== 0 ? (s / Math.abs(m)) * 100 : null,
    min, q1, median: med, q3, max,
    range: max - min, iqr: q3 - q1,
    skewness, kurtosis, sum,
    ad, adAvailable, adUnavailableReason,
    ciMean, ciMedian: medianCI(sorted), ciStdev,
  };
}
