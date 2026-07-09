/** 描述性统计:基本量、四分位、偏度/峰度、置信区间。 */
import { describe, it, expect } from 'vitest';
import { computeDescriptive } from '../descriptive';

describe('描述性统计 · 1..10', () => {
  const d = computeDescriptive([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  it('N/和/极值/极差', () => {
    expect(d.n).toBe(10);
    expect(d.sum).toBe(55);
    expect(d.min).toBe(1);
    expect(d.max).toBe(10);
    expect(d.range).toBe(9);
  });
  it('均值/中位数', () => {
    expect(d.mean).toBeCloseTo(5.5, 10);
    expect(d.median).toBeCloseTo(5.5, 10);
  });
  it('样本标准差与方差', () => {
    expect(d.stdev).toBeCloseTo(3.02765, 4);
    expect(d.variance).toBeCloseTo(9.16667, 4);
    expect(d.seMean).toBeCloseTo(3.02765 / Math.sqrt(10), 4);
  });
  it('四分位与 IQR(线性插值)', () => {
    expect(d.q1).toBeCloseTo(3.25, 10);
    expect(d.q3).toBeCloseTo(7.75, 10);
    expect(d.iqr).toBeCloseTo(4.5, 10);
  });
  it('对称数据偏度≈0', () => {
    expect(Math.abs(d.skewness)).toBeLessThan(1e-9);
  });
  it('均值置信区间包住均值且对称', () => {
    expect(d.ciMean[0]).toBeLessThan(d.mean);
    expect(d.ciMean[1]).toBeGreaterThan(d.mean);
    expect((d.ciMean[0] + d.ciMean[1]) / 2).toBeCloseTo(d.mean, 8);
  });
  it('标准差置信区间包住 s 且为正', () => {
    expect(d.ciStdev[0]).toBeGreaterThan(0);
    expect(d.ciStdev[0]).toBeLessThan(d.stdev);
    expect(d.ciStdev[1]).toBeGreaterThan(d.stdev);
  });
  it('CV = 100·s/x̄', () => {
    expect(d.cv).toBeCloseTo((d.stdev / d.mean) * 100, 8);
  });
});

describe('偏度符号', () => {
  it('右偏数据偏度为正', () => {
    const d = computeDescriptive([1, 1, 1, 2, 2, 3, 10]);
    expect(d.skewness).toBeGreaterThan(0);
  });
  it('左偏数据偏度为负', () => {
    const d = computeDescriptive([1, 8, 9, 9, 10, 10, 10]);
    expect(d.skewness).toBeLessThan(0);
  });
});

describe('边界', () => {
  it('少于 2 个观测抛错', () => {
    expect(() => computeDescriptive([5])).toThrow();
  });
  it('过滤非有限值', () => {
    const d = computeDescriptive([1, 2, NaN, 3, Infinity]);
    expect(d.n).toBe(3);
  });
});
