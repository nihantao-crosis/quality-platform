/** 渲染降采样 + 大数组安全 min/max。 */
import { describe, it, expect } from 'vitest';
import { decimateUniform, decimateMinMax, arrMin, arrMax, evalFormula } from '..';

describe('arrMin/arrMax(大数组不栈溢出)', () => {
  it('50 万元素求极值', () => {
    const xs = Array.from({ length: 500_000 }, (_, i) => Math.sin(i));
    expect(arrMin(xs)).toBeGreaterThanOrEqual(-1);
    expect(arrMax(xs)).toBeLessThanOrEqual(1);
    expect(arrMax(xs)).toBeGreaterThan(0.999);
  });
});

describe('decimateUniform', () => {
  it('小于上限时全保留', () => {
    expect(decimateUniform(10, 100)).toHaveLength(10);
  });
  it('大于上限时约等于上限,含首尾', () => {
    const idx = decimateUniform(100_000, 800);
    expect(idx.length).toBeLessThanOrEqual(801);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(99_999);
    // 严格递增
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });
  it('keep 索引必留', () => {
    const idx = decimateUniform(100_000, 100, [12_345, 67_890]);
    expect(idx).toContain(12_345);
    expect(idx).toContain(67_890);
  });
});

describe('decimateMinMax(保形)', () => {
  it('全局极值点必被保留', () => {
    const data = Array.from({ length: 50_000 }, (_, i) => Math.sin(i / 100));
    data[23_456] = 99;  // 尖峰
    data[34_567] = -99; // 深谷
    const idx = decimateMinMax(data, 600);
    expect(idx).toContain(23_456);
    expect(idx).toContain(34_567);
    expect(idx.length).toBeLessThanOrEqual(620);
  });
  it('失控点(keep)必留;首尾必留', () => {
    const data = Array.from({ length: 10_000 }, () => 25);
    const idx = decimateMinMax(data, 300, [7_777]);
    expect(idx).toContain(7_777);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(9_999);
  });
  it('小数据不动', () => {
    expect(decimateMinMax([1, 2, 3], 600)).toEqual([0, 1, 2]);
  });
});

describe('公式引擎大数组聚合(回归防护)', () => {
  it('20 万行 min/max/range 不崩', () => {
    const col = Array.from({ length: 200_000 }, (_, i) => (i % 1000) / 100);
    const ctx = { columns: [col], colNames: ['x'], rowCount: col.length };
    expect(evalFormula('max(C1)', ctx).values[0]).toBeCloseTo(9.99, 6);
    expect(evalFormula('min(C1)', ctx).values[0]).toBe(0);
    expect(evalFormula('range(C1)', ctx).values[0]).toBeCloseTo(9.99, 6);
  });
});
