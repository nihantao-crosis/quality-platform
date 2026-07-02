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
