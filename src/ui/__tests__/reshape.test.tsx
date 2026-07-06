/**
 * 数据重构测试 — 转置 / 堆叠 / 最近列表移除。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useData } from '../../store/dataStore';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
});

describe('转置列', () => {
  it('k×n → n×k,值对应转置', () => {
    useData.getState().importMatrix('t.csv', ['a', 'b', 'c'], [[1, 2, 3], [4, 5, 6]]);
    useData.getState().transposeDataset();
    const m = useData.getState().model;
    expect(m.name).toBe('t.csv (转置)');
    expect(m.k).toBe(3);
    expect(m.n).toBe(2);
    expect(m.subs.map((s) => s.vals)).toEqual([[1, 4], [2, 5], [3, 6]]);
    expect(m.colNames).toEqual(['子组1', '子组2']);
  });
  it('转置后子组 > 10 拒绝', () => {
    const rows = Array.from({ length: 11 }, (_, i) => [i, i + 1]);
    useData.getState().importMatrix('big.csv', ['a', 'b'], rows);
    expect(() => useData.getState().transposeDataset()).toThrow();
  });
});

describe('堆叠列', () => {
  it('多列 → 单列 + 来源列(按列堆叠)', () => {
    useData.getState().importMatrix('s.csv', ['甲', '乙'], [[1, 10], [2, 20], [3, 30]]);
    useData.getState().stackColumns();
    const st = useData.getState();
    expect(st.model.name).toBe('s.csv (堆叠)');
    expect(st.model.k).toBe(6);
    expect(st.model.n).toBe(1);
    expect(st.model.subs.map((s) => s.vals[0])).toEqual([1, 2, 3, 10, 20, 30]);
    expect(st.textCols[0].name).toBe('来源列');
    expect(st.textCols[0].values).toEqual(['甲', '甲', '甲', '乙', '乙', '乙']);
  });
});

describe('最近列表移除', () => {
  it('removeRecent 只删列表项,不影响当前数据集', () => {
    useData.getState().importMatrix('r.csv', ['x'], [[1], [2], [3]]);
    expect(useData.getState().recents.some((r) => r.name === 'r.csv')).toBe(true);
    useData.getState().removeRecent('r.csv');
    expect(useData.getState().recents.some((r) => r.name === 'r.csv')).toBe(false);
    expect(useData.getState().model.name).toBe('r.csv');
  });
});
