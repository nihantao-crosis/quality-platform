/**
 * 描述性统计（对标 Minitab Basic Statistics → Display / Graphical Summary）。
 * 纯函数,复用 basicMath/normality/ttest 中已有的数值零件。
 */
import { mean, stdev, median, quantile, invNorm } from './basicMath';
import { andersonDarling, type AdResult } from './normality';
import { tInv } from './ttest';

export interface Descriptive {
  n: number;
  mean: number;
  seMean: number;       // 均值标准误 = s/√n
  stdev: number;        // 样本标准差
  variance: number;
  cv: number;           // 变异系数 % = 100·s/x̄
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
  ciMean: [number, number];    // 均值 95% 置信区间（t）
  ciMedian: [number, number];  // 中位数 95% 置信区间（次序统计）
  ciStdev: [number, number];   // 标准差 95% 置信区间（卡方,Wilson–Hilferty）
}

/** χ²(p, k) 分位数 —— Wilson–Hilferty 近似(用逆正态),适合中大自由度。 */
function chi2Inv(p: number, k: number): number {
  const z = invNorm(p);
  const t = 1 - 2 / (9 * k) + z * Math.sqrt(2 / (9 * k));
  return k * t * t * t;
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

  const adAvailable = n >= 8;
  const ad: AdResult = adAvailable
    ? andersonDarling(xs)
    : { a2: NaN, a2star: NaN, p: NaN, normal: true, n };

  return {
    n, mean: m, seMean, stdev: s, variance,
    cv: m !== 0 ? (s / Math.abs(m)) * 100 : 0,
    min, q1, median: med, q3, max,
    range: max - min, iqr: q3 - q1,
    skewness, kurtosis, sum,
    ad, adAvailable,
    ciMean, ciMedian: medianCI(sorted), ciStdev,
  };
}
