/** 批次F:外部审核 v1.27.0 确认缺陷的回归(引擎部分)。 */
import { describe, it, expect } from 'vitest';
import { oneWayAnova } from '../index';

describe('P1-3 · ANOVA 组内零方差不再得 P=NaN', () => {
  it('组内零方差、组间有差异 → 无穷显著(p=0),而非 NaN/不显著', () => {
    const r = oneWayAnova([[1, 1], [2, 2]]);
    expect(Number.isNaN(r.pValue)).toBe(false);
    expect(r.pValue).toBe(0);
    expect(r.significant).toBe(true);
    expect(r.fStat).toBe(Infinity);
  });
  it('组内零方差、组间也无差异 → 不显著(p=1)', () => {
    const r = oneWayAnova([[5, 5], [5, 5]]);
    expect(r.pValue).toBe(1);
    expect(r.significant).toBe(false);
  });
  it('正常数据仍走常规 F 检验', () => {
    const r = oneWayAnova([[10, 12, 11], [20, 22, 21]]);
    expect(Number.isFinite(r.fStat)).toBe(true);
    expect(r.significant).toBe(true);
  });
});
