/**
 * 数据子集 · 条件筛选 — addFormulaColumn + subsetByCondition。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useData } from '../../store/dataStore';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  // C1=[1,2,3,4,5], C2=[10,20,30,40,50]
  useData.getState().importMatrix('t.csv', ['x', 'y'],
    [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50]]);
});

describe('公式计算列', () => {
  it('追加 (C1+C2)/2 列', () => {
    const err = useData.getState().addFormulaColumn('均值', '(C1 + C2) / 2');
    expect(err).toBeNull();
    const m = useData.getState().model;
    expect(m.colNames).toEqual(['x', 'y', '均值']);
    expect(m.subs.map((s) => s.vals[2])).toEqual([5.5, 11, 16.5, 22, 27.5]);
  });
  it('非法公式返回错误信息', () => {
    const err = useData.getState().addFormulaColumn('z', 'foo(C1)');
    expect(err).toContain('未知函数');
    expect(useData.getState().model.n).toBe(2); // 未追加
  });
});

describe('条件筛选', () => {
  it('C1 >= 3 保留后三行', () => {
    const r = useData.getState().subsetByCondition('C1 >= 3');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kept).toBe(3);
      expect(r.total).toBe(5);
      expect(r.name).toBe('t (子集)');
    }
    const m = useData.getState().model;
    expect(m.k).toBe(3);
    expect(m.subs.map((s) => s.vals[0])).toEqual([3, 4, 5]);
  });
  it('区间条件 and', () => {
    const r = useData.getState().subsetByCondition('C1 >= 2 and C1 <= 4');
    expect(r.ok && r.kept).toBe(3);
  });
  it('条件对全部成立 → 拒绝', () => {
    const r = useData.getState().subsetByCondition('C1 > 0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('未筛除');
  });
  it('命中不足 2 行 → 拒绝', () => {
    const r = useData.getState().subsetByCondition('C1 > 4');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不足 2 行');
  });
  it('非法条件返回错误', () => {
    const r = useData.getState().subsetByCondition('C1 >');
    expect(r.ok).toBe(false);
  });
});
