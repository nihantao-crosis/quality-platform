/**
 * 描述性统计（对标 Minitab Basic Statistics → Display / Graphical Summary）。
 * 纯函数,复用 basicMath/normality/ttest 中已有的数值零件。
 */
import { mean, stdev, median, minitabQuantile, stableSum, lgamma } from './basicMath';
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
  ciMedian: [number, number];
  /** 中位数区间实际达成的置信度(n<6 时 <0.95) */
  ciMedianAchieved: number;  // 中位数 95% 置信区间（次序统计）
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

/** 中位数的分布无关 ≥95% CI:取最大的 l 使 P(X ≤ l−1) ≤ 0.025(X~Bin(n,1/2)),
 * CI = [x(l), x(n+1−l)]。双审 P3:旧正态近似两端各多放一位,n=10 时给 [x(1),x(10)],
 * 实际覆盖 99.8% 而标称 95%。n<6 时任何次序统计量对都达不到 95%,退回全距。 */
/** 中位数区间的**实际达成置信度**(蜂群 P3-01:n<6 时区间退回全距,
 * 覆盖率只有 1−2×0.5^n = 50%/75%/87.5%/93.75%,界面却无条件标「95%」)。
 * n≥6 时精确秩可达 ≥95%,返回 0.95。 */
export function medianCiAchieved(n: number): number {
  if (n < 2) return 0;
  if (n >= 6) return 0.95;
  return 1 - 2 * Math.pow(0.5, n);
}

function medianCI(sorted: number[]): [number, number] {
  const n = sorted.length;
  let l = 1;
  if (n <= 1000) {
    let pk = Math.pow(0.5, n); // P(X = 0)
    let cum = pk;
    if (cum > 0.025) return [sorted[0], sorted[n - 1]];
    while (l < n) {
      const pNext = pk * (n - (l - 1)) / l; // P(X = l)
      if (cum + pNext > 0.025) break;
      cum += pNext; pk = pNext; l += 1;
    }
  } else {
    // 大 n:带连续性校正的正态近似(0.5^n 下溢,精确累计不可行)
    l = Math.max(1, Math.floor(n / 2 - 0.979981992270027 * Math.sqrt(n) - 0.5) + 1);
  }
  return [sorted[l - 1], sorted[n - l]];
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

  // 偏度 g1、超额峰度 g2(含无偏小样本校正,与 Minitab 一致)。高阶矩只需要
  // 无量纲比值：先以一个实际样本值为原点中心化，再按最大绝对离差缩放。
  // 这样 d³/d⁴ 始终在 [-1,1] 内累加，不会因 Pa↔MPa 之类合法单位变换
  // 溢出/下溢。当原坐标差超出 Number 值域时，先缩放坐标再做同一计算。
  const origin = xs[0];
  const offsets = xs.map((value) => value - origin);
  const offsetsFinite = offsets.every(Number.isFinite);
  const momentCoordinates = offsetsFinite
    ? offsets
    : (() => {
        const coordinateScale = xs.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
        const scaled = xs.map((value) => value / coordinateScale);
        const scaledOrigin = scaled[0];
        return scaled.map((value) => value - scaledOrigin);
      })();
  const momentCenter = mean(momentCoordinates);
  const centered = momentCoordinates.map((value) => value - momentCenter);
  const momentScale = centered.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  let m2 = 0, m3 = 0, m4 = 0;
  if (momentScale > 0) {
    for (const deviation of centered) {
      const d = deviation / momentScale;
      const d2 = d * d;
      m2 += d2;
      m3 += d2 * d;
      m4 += d2 * d2;
    }
  }
  m2 /= n; m3 /= n; m4 /= n;
  // 常量列(m2=0)时偏度/峰度不可估计:返回 NaN 由展示层写「—」,
  // 而不是把 0/0 硬编码成 b2=0 后继续走校正得出 −8.000 之类的伪值(双审 P3)
  const b1 = m2 > 0 ? m3 / (Math.sqrt(m2) ** 3) : Number.NaN;
  const b2 = m2 > 0 ? m4 / (m2 * m2) : Number.NaN;
  const skewness = n > 2 ? (Math.sqrt(n * (n - 1)) / (n - 2)) * b1 : Number.NaN;
  const kurtosis = n > 3
    ? ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * (b2 - 3) + 6)
    : b2 - 3;

  const q1 = minitabQuantile(sorted, 0.25, true);
  const q3 = minitabQuantile(sorted, 0.75, true);
  const med = median(sorted, true);
  const min = sorted[0];
  const max = sorted[n - 1];
  const sum = stableSum(xs); // 与 mean/公式引擎同一稳定求和口径,报表「总和」恒等于均值×n 量级

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
    ? andersonDarling(sorted, true)
    : { a2: NaN, a2star: NaN, p: NaN, normal: true, n };

  return {
    n, mean: m, seMean, stdev: s, variance,
    cv: m !== 0 ? (s / Math.abs(m)) * 100 : null,
    min, q1, median: med, q3, max,
    range: max - min, iqr: q3 - q1,
    skewness, kurtosis, sum,
    ad, adAvailable, adUnavailableReason,
    ciMean, ciMedian: medianCI(sorted), ciMedianAchieved: medianCiAchieved(n), ciStdev,
  };
}
