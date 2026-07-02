/**
 * 基础数学 — 从原型 质量分析平台.dc.html class Component 逐字迁移。
 * 勿改公式（交接文档 §8.1）。
 */

/** 误差函数（Abramowitz-Stegun 近似） */
export function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/** 标准正态 CDF：Φ(z) = 0.5·(1 + erf(z/√2)) */
export function phi(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** 逆标准正态（Acklam 算法），用于 Z.bench */
export function invNorm(p: number): number {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const ph = 1 - pl;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= ph) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** 二项累积分布 P(X≤k)，用于 AQL / OC 曲线 */
export function binomCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let pmf = Math.pow(1 - p, n);
  let cum = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) pmf = ((pmf * (n - i + 1)) / i) * (p / (1 - p));
    cum += pmf;
  }
  return Math.min(1, cum);
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** sample=true → n-1 分母（默认样本标准差） */
export function stdev(xs: number[], sample = true): number {
  const m = mean(xs);
  const denom = sample ? xs.length - 1 : xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / denom);
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 分位数（线性插值），f ∈ [0,1] */
export function quantile(xs: number[], f: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * f;
  const b = Math.floor(idx);
  return s[b] + ((s[b + 1] - s[b]) || 0) * (idx - b);
}

/** 数字格式化（原型 nf） */
export function nf(v: number, d: number): string {
  return Number(v).toFixed(d);
}

/** ln Γ(x)（Lanczos 近似，g=7） */
export function lgamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 不完全贝塔连分式（Numerical Recipes betacf） */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** 正则化不完全贝塔函数 I_x(a,b) */
export function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** F 分布 CDF：P(F(d1,d2) ≤ f)。用于 ANOVA P 值。 */
export function fCdf(f: number, d1: number, d2: number): number {
  if (f <= 0) return 0;
  return betai(d1 / 2, d2 / 2, (d1 * f) / (d1 * f + d2));
}
