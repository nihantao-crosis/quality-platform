/**
 * 数据重构测试 — 转置 / 堆叠 / 最近列表移除。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useData } from '../../store/dataStore';
import { prepareSpcData } from '../../core';

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
    expect(m.colNames).toEqual(['测量1', '测量2']);
    expect(useData.getState().textCols).toEqual([{ name: '原列子组', values: ['a', 'b', 'c'] }]);
  });
  it('超过 10 个子组列可导入并转置，原列名作为子组标签保留', () => {
    const names = Array.from({ length: 12 }, (_, i) => `批次-${101 + i}`);
    const rows = Array.from({ length: 5 }, (_, i) => names.map((_, j) => j * 10 + i));
    useData.getState().importMatrix('12列.csv', names, rows);
    expect(useData.getState().model.n).toBe(12);

    useData.getState().transposeDataset();

    const st = useData.getState();
    expect(st.model.k).toBe(12);
    expect(st.model.n).toBe(5);
    expect(st.model.colNames).toEqual(['测量1', '测量2', '测量3', '测量4', '测量5']);
    expect(st.textCols).toEqual([{ name: '原列子组', values: names }]);
    const reopened = prepareSpcData(st.model, st.textCols, { layout: 'auto', valueColumn: null, subgroupColumn: null });
    expect(reopened.subgroupLabels).toEqual(names); // 即使角色偏好丢失，也能从保留列自动恢复
  });
  it('指定子组列转置时排除测量序号列', () => {
    const groups = Array.from({ length: 11 }, (_, i) => `G${i + 1}`);
    const names = ['测量序号', ...groups];
    const rows = Array.from({ length: 5 }, (_, i) => [i + 1, ...groups.map((_, j) => j + i / 10)]);
    useData.getState().importMatrix('含索引.csv', names, rows);

    useData.getState().transposeDataset(groups);

    const st = useData.getState();
    expect(st.model.k).toBe(11);
    expect(st.model.n).toBe(5);
    expect(st.textCols[0].values).toEqual(groups);
    expect(st.model.subs[0].vals).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
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
