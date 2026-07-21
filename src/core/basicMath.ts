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

/**
 * 泊松累积分布 P(X≤k)，X~Poisson(λ)。
 * 用于 AQL「每百单位不合格数」体系(GB/T 2828.1 AQL≥15,λ=n·AQL/100,d 可大于 n)。
 *
 * 逐项概率在对数空间生成:log p_i = −λ + i·lnλ − lnΓ(i+1)，再按 log-sum-exp
 * 折回线性域。λ 较大时单项 e^{−λ} 在线性域直接下溢为 0(λ>745 时 e^{−λ} 即为 0)，
 * 朴素递推会把整段 CDF 算成 0/NaN;对数空间先减最大项则对任意 λ 数值稳定。
 * k 就地向下取整;λ≤0 时全部概率质量在 X=0，P(X≤k)=1(k≥0)。
 */
export function poissonCdf(k: number, lambda: number): number {
  const kk = Math.floor(k);
  if (kk < 0) return 0;
  if (!(lambda > 0)) return 1;
  const logLambda = Math.log(lambda);
  const logs = new Array<number>(kk + 1);
  let maxLog = -Infinity;
  for (let i = 0; i <= kk; i++) {
    const lp = -lambda + i * logLambda - lgamma(i + 1);
    logs[i] = lp;
    if (lp > maxLog) maxLog = lp;
  }
  let sum = 0;
  for (let i = 0; i <= kk; i++) sum += Math.exp(logs[i] - maxLog);
  // 理论上 maxLog + log(sum) ≤ 0;浮点噪声用 min(1,·) 截断
  return Math.min(1, Math.exp(maxLog + Math.log(sum)));
}

/**
 * 以首个观测为原点并对偏移量做 Neumaier 补偿求和。
 *
 * 直接累加大基准数据（例如 1e15±1）会先丢掉低位，再除以 n，导致均值和所有
 * 依赖均值的推断随“加同一个常数”而改变。偏移量求和既保留低位，也避免把无关
 * 的绝对基准带入累计误差。
 */
function offsetMean(xs: number[]): { origin: number; offset: number } {
  if (xs.length === 0) return { origin: 0, offset: Number.NaN };
  const origin = xs[0];
  let sum = 0;
  let correction = 0;
  for (let i = 1; i < xs.length; i++) {
    const value = xs[i] - origin;
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  return { origin, offset: (sum + correction) / xs.length };
}

/**
 * 缩放后的 Neumaier 补偿求和。先除以最大绝对值可避免合法有限输入因中间加法
 * 提前溢出；补偿项保留大数相消后的低位。最终真实结果超出 Number 范围时仍返回 ±∞。
 */
export function stableSum(xs: number[]): number {
  if (xs.some((value) => !Number.isFinite(value))) return xs.reduce((sum, value) => sum + value, 0);
  let scale = 0;
  for (const value of xs) scale = Math.max(scale, Math.abs(value));
  if (scale === 0) return 0;
  let sum = 0;
  let correction = 0;
  for (const raw of xs) {
    const value = raw / scale;
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  return (sum + correction) * scale;
}

/** 值域守卫(v1.42.3,审计 P2):offsetMean 里 (x − origin) 单项差最大 2·maxAbs,且 n 项
 * 累加的部分和最坏可达 2·maxAbs·(n−1)——单项差不溢出但部分和溢出同样会输出 NaN(mean)
 * 或静默 0(stdev,对抗审查反例 [-4e307, 4e307, 4e307, 4e307])。因此阈值必须随样本量收紧:
 * maxAbs > MAX_VALUE/(4n) 即整体按最大绝对值缩放后计算再乘回(缩放后 maxAbs=1,不会复触发)。
 * 输入含非有限值时守卫不触发,保持既有 NaN 传播行为。 */
const OFFSET_OVERFLOW_GUARD = Number.MAX_VALUE / 4;

function offsetGuardThreshold(n: number): number {
  return OFFSET_OVERFLOW_GUARD / Math.max(1, n);
}

function maxAbs(xs: number[]): number {
  let m = 0;
  for (const v of xs) {
    const a = Math.abs(v);
    if (a > m) m = a;
  }
  return m;
}

export function mean(xs: number[]): number {
  const scale = maxAbs(xs);
  if (Number.isFinite(scale) && scale > offsetGuardThreshold(xs.length)) {
    return scale * mean(xs.map((v) => v / scale));
  }
  const centered = offsetMean(xs);
  return xs.length === 0 ? Number.NaN : centered.origin + centered.offset;
}

/** sample=true → n-1 分母（默认样本标准差） */
export function stdev(xs: number[], sample = true): number {
  const guardScale = maxAbs(xs);
  if (Number.isFinite(guardScale) && guardScale > offsetGuardThreshold(xs.length)) {
    return guardScale * stdev(xs.map((v) => v / guardScale), sample);
  }
  const denom = sample ? xs.length - 1 : xs.length;
  const centered = offsetMean(xs);
  // 在偏移坐标内计算离差，避免先把均值舍入回大基准后再相减。
  // 缩放平方和算法同时避免合法有限输入在平方时不必要地上溢/下溢。
  let scale = 0;
  let sumSquares = 1;
  for (let i = 0; i < xs.length; i++) {
    const deviation = Math.abs((xs[i] - centered.origin) - centered.offset);
    if (deviation === 0) continue;
    if (scale < deviation) {
      sumSquares = 1 + sumSquares * (scale / deviation) ** 2;
      scale = deviation;
    } else {
      sumSquares += (deviation / scale) ** 2;
    }
  }
  if (scale === 0) return Math.sqrt(0 / denom);
  return scale * Math.sqrt(sumSquares / denom);
}

/**
 * 均方根 sqrt(Σx²/n)。缩放后再累计平方，避免直接 x² 在极端量纲下溢出/上溢。
 * 主要供 Cpm 的目标偏差与等自由度合并标准差使用。
 */
export function rootMeanSquare(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  let scale = 0;
  let sumSquares = 1;
  for (const value of xs) {
    const magnitude = Math.abs(value);
    if (!Number.isFinite(magnitude)) return magnitude;
    if (magnitude === 0) continue;
    if (scale < magnitude) {
      sumSquares = 1 + sumSquares * (scale / magnitude) ** 2;
      scale = magnitude;
    } else {
      sumSquares += (magnitude / scale) ** 2;
    }
  }
  return scale === 0 ? 0 : scale * Math.sqrt(sumSquares / xs.length);
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


/** 大数组安全 min/max（Math.min(...xs) 在 ~6.5 万元素以上会栈溢出） */
export function arrMin(xs: number[]): number {
  let m = Infinity;
  for (let i = 0; i < xs.length; i++) if (xs[i] < m) m = xs[i];
  return m;
}

export function arrMax(xs: number[]): number {
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) if (xs[i] > m) m = xs[i];
  return m;
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

/** 数据显示分辨率：一组原始值的最大小数位数（批次720-A3，Minitab 式控制图标签位数：
 * 均值类图 = 数据位数+1，极差类图 = 数据位数）。科学计数法值直接取 cap。 */
export function dataDecimals(xs: number[], cap = 3): number {
  let dp = 0;
  for (const v of xs) {
    if (!Number.isFinite(v)) continue;
    const s = String(v);
    if (s.includes('e') || s.includes('E')) return cap;
    const dot = s.indexOf('.');
    if (dot >= 0) dp = Math.max(dp, Math.min(cap, s.length - dot - 1));
    if (dp >= cap) break;
  }
  return dp;
}
