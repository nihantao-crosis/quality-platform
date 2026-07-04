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
  const n = Math.min(xs.length, ys.length);
  if (n < 3) throw new Error('回归至少需要 3 组观测');
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
  const r = syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
  const r2 = r * r;
  const df = n - 2;
  // 残差方差 → 斜率标准误
  const sse = syy - slope * sxy;
  const mse = Math.max(0, sse) / df;
  const seSlope = Math.sqrt(mse / sxx);
  const t = seSlope === 0 ? 0 : slope / seSlope;
  const p = seSlope === 0 ? 0 : tTwoSidedP(t, df);
  return { slope, intercept, r, r2, seSlope, t, df, p, significant: p < 0.05, n };
}
