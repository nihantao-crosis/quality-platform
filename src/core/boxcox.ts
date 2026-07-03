/**
 * Box-Cox 变换 — λ 网格寻优（最大化对数似然），用于非正态数据的能力分析。
 * 要求数据全部为正。
 */
import { mean } from './basicMath';

export function boxCoxTransform(x: number, lambda: number): number {
  return Math.abs(lambda) < 1e-9 ? Math.log(x) : (Math.pow(x, lambda) - 1) / lambda;
}

/** λ ∈ [-2, 2]（步长 0.1）网格上最大化 profile 对数似然 */
export function bestLambda(xs: number[]): { lambda: number; logLik: number } | { error: string } {
  if (xs.some((x) => x <= 0)) return { error: 'Box-Cox 要求数据全部为正' };
  const n = xs.length;
  const sumLog = xs.reduce((a, x) => a + Math.log(x), 0);
  let best = { lambda: 1, logLik: -Infinity };
  for (let l = -20; l <= 20; l++) {
    const lambda = l / 10;
    const y = xs.map((x) => boxCoxTransform(x, lambda));
    const my = mean(y);
    const varY = y.reduce((a, v) => a + (v - my) ** 2, 0) / n;
    if (varY <= 0) continue;
    const ll = (-n / 2) * Math.log(varY) + (lambda - 1) * sumLog;
    if (ll > best.logLik) best = { lambda, logLik: ll };
  }
  return best;
}

/** 变换数据与规格限（λ<0 时变换单调递减，需交换上下限） */
export function transformWithSpec(
  xs: number[],
  lsl: number,
  usl: number,
  lambda: number,
): { data: number[]; lsl: number; usl: number } | { error: string } {
  if (xs.some((x) => x <= 0) || lsl <= 0 || usl <= 0) return { error: '数据与规格限必须为正' };
  const data = xs.map((x) => boxCoxTransform(x, lambda));
  let tl = boxCoxTransform(lsl, lambda);
  let tu = boxCoxTransform(usl, lambda);
  if (tl > tu) [tl, tu] = [tu, tl];
  return { data, lsl: tl, usl: tu };
}
