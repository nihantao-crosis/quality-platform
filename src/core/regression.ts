/**
 * 简单线性回归 — 最小二乘 y = a + bx,含相关系数与斜率显著性检验。
 */
import { mean } from './basicMath';
import { tTwoSidedP } from './ttest';

export interface RegressionResult {
  slope: number; // b
  intercept: number; // a
  r: number; // Pearson 相关系数
  r2: number;
  seSlope: number; // 斜率标准误
  t: number; // 斜率 t 统计量
  df: number; // n − 2
  p: number; // 斜率显著性(双侧)
  significant: boolean;
  n: number;
}

export function linearRegression(xs: number[], ys: number[]): RegressionResult {
  if (xs.length !== ys.length) throw new Error('回归的 X 与 Y 观测数必须相同');
  const n = xs.length;
  if (n < 3) throw new Error('回归至少需要 3 组观测');
  if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) {
    throw new Error('回归只接受有限数值');
  }
  const x = xs.slice(0, n);
  const y = ys.slice(0, n);
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  if (sxx === 0) throw new Error('X 无变异,无法回归');
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const rawR = syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
  const r = Math.max(-1, Math.min(1, rawR));
  const r2 = r * r;
  const df = n - 2;
  // 残差方差 → 斜率标准误
  const rawSse = syy - slope * sxy;
  // SSE 与 syy 同量纲，只能按它们自身的尺度吸收浮点舍入；Math.max(1, ...)
  // 会把小量纲数据的真实残差当成 0，并破坏单位缩放不变性。
  const sseScale = Math.max(Math.abs(syy), Math.abs(slope * sxy));
  const roundoff = Number.EPSILON * sseScale * n * 16;
  const sse = Math.abs(rawSse) <= roundoff ? 0 : Math.max(0, rawSse);
  const mse = sse / df;
  const seSlope = Math.sqrt(mse / sxx);
  // 零残差需要区分两种情形：常数 Y 的斜率就是 0（P=1）；完美的非水平
  // 直线则斜率标准误为 0 且斜率非零（|t|=∞, P=0）。
  // “响应恒定”是数据结构事实，不能拿斜率与 Y 的位置（均值）比较；给 Y 加常数
  // 不应改变斜率检验。完全拟合且响应并非常数时，非零斜率的 P=0。
  const constantResponse = y.every((value) => value === y[0]);
  const t = seSlope === 0 ? (constantResponse ? 0 : Math.sign(slope) * Infinity) : slope / seSlope;
  const p = seSlope === 0 ? (constantResponse ? 1 : 0) : tTwoSidedP(t, df);
  return { slope, intercept, r, r2, seSlope, t, df, p, significant: p < 0.05, n };
}
