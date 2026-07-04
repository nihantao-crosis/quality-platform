/**
 * 线性回归对拍 — 教科书例:x=[1..5], y=[2,4,5,4,5] → b=0.6, a=2.2, r²=0.6。
 */
import { describe, it, expect } from 'vitest';
import { linearRegression } from '../regression';

describe('简单线性回归', () => {
  it('教科书已知值', () => {
    const r = linearRegression([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]);
    expect(r.slope).toBeCloseTo(0.6, 10);
    expect(r.intercept).toBeCloseTo(2.2, 10);
    expect(r.r).toBeCloseTo(0.7746, 4);
    expect(r.r2).toBeCloseTo(0.6, 10);
    expect(r.df).toBe(3);
    expect(r.t).toBeCloseTo(2.1213, 3);
    expect(r.p).toBeGreaterThan(0.11);
    expect(r.p).toBeLessThan(0.14);
    expect(r.significant).toBe(false);
  });
  it('完全线性 → r=±1 且显著', () => {
    const r = linearRegression([1, 2, 3, 4], [10, 8, 6, 4]);
    expect(r.r).toBeCloseTo(-1, 10);
    expect(r.slope).toBeCloseTo(-2, 10);
    expect(r.significant).toBe(true);
  });
  it('X 无变异报错;观测不足报错', () => {
    expect(() => linearRegression([2, 2, 2], [1, 2, 3])).toThrow();
    expect(() => linearRegression([1, 2], [1, 2])).toThrow();
  });
});
