/**
 * t 检验对拍 — 教科书已知值。
 */
import { describe, it, expect } from 'vitest';
import { tCdf, tInv, oneSampleT, twoSampleT } from '../ttest';

describe('t 分布', () => {
  it('tCdf 对称性与已知值', () => {
    expect(tCdf(0, 10)).toBeCloseTo(0.5, 10);
    // t=2.228, df=10 → 单侧 0.975（t 表标准值）
    expect(tCdf(2.228, 10)).toBeCloseTo(0.975, 3);
    expect(tCdf(-2.228, 10)).toBeCloseTo(0.025, 3);
  });
  it('tInv 与 tCdf 互逆（t 表值 2.306 @ df=8, 0.975）', () => {
    expect(tInv(0.975, 8)).toBeCloseTo(2.306, 2);
    expect(tCdf(tInv(0.95, 20), 20)).toBeCloseTo(0.95, 6);
  });
});

describe('单样本 t', () => {
  it('均值恰为 μ0 → t=0, p=1', () => {
    const r = oneSampleT([5.1, 4.9, 5.0, 5.2, 4.8], 5.0);
    expect(r.t).toBeCloseTo(0, 10);
    expect(r.p).toBeCloseTo(1, 10);
    expect(r.significant).toBe(false);
    expect(r.ciLow).toBeLessThan(5);
    expect(r.ciHigh).toBeGreaterThan(5);
  });
  it('明显偏移检出显著', () => {
    const r = oneSampleT([5.1, 5.2, 5.15, 5.18, 5.22, 5.12], 5.0);
    expect(r.significant).toBe(true);
    expect(r.p).toBeLessThan(0.01);
  });
  it('零方差边界：常数等于目标不显著，常数偏离目标为无穷 t / P=0', () => {
    const equal = oneSampleT([5, 5, 5], 5);
    expect(equal).toMatchObject({ t: 0, p: 1, significant: false, se: 0, ciLow: 5, ciHigh: 5 });
    const shifted = oneSampleT([5, 5, 5], 0);
    expect(shifted.t).toBe(Infinity);
    expect(shifted).toMatchObject({ p: 0, significant: true, se: 0, ciLow: 5, ciHigh: 5 });
  });
  it('拒绝非有限观测或目标', () => {
    expect(() => oneSampleT([1, Number.NaN], 0)).toThrow('有限数值');
    expect(() => oneSampleT([1, 2], Infinity)).toThrow('有限数值');
  });
});

describe('双样本 t (Welch)', () => {
  it('教科书例：A=[1..5] B=[3..7] → t=-2, df=8, p≈0.0805', () => {
    const r = twoSampleT([1, 2, 3, 4, 5], [3, 4, 5, 6, 7]);
    expect(r.t).toBeCloseTo(-2, 10);
    expect(r.df).toBeCloseTo(8, 6);
    expect(r.p).toBeCloseTo(0.0805, 3);
    expect(r.estimate).toBe(-2);
    expect(r.significant).toBe(false);
  });
  it('同分布两组不显著', () => {
    const r = twoSampleT([1, 2, 3], [1, 2, 3]);
    expect(r.p).toBeCloseTo(1, 10);
  });
  it('两组零方差边界：相同常数 P=1，不同常数 |t|=∞ / P=0', () => {
    expect(twoSampleT([5, 5], [5, 5])).toMatchObject({ t: 0, p: 1, significant: false, se: 0 });
    const different = twoSampleT([5, 5], [4, 4]);
    expect(different.t).toBe(Infinity);
    expect(different).toMatchObject({ estimate: 1, p: 0, significant: true, se: 0, ciLow: 1, ciHigh: 1 });
  });
});
