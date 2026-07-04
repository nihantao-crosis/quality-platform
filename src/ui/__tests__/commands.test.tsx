/**
 * 数据集命令测试 — 撤销/重做/新建/另存为/标准化/随机/排序。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useData } from '../../store/dataStore';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ undoStack: [], redoStack: [] });
});

describe('撤销 / 重做', () => {
  it('编辑 → 撤销恢复原值 → 重做恢复编辑', () => {
    const s = useData.getState();
    const orig = s.model.subs[0].vals[0];
    s.updateCell(0, 0, 99);
    expect(useData.getState().model.subs[0].vals[0]).toBe(99);
    expect(useData.getState().undoEdit()).toBe(true);
    expect(useData.getState().model.subs[0].vals[0]).toBeCloseTo(orig, 10);
    expect(useData.getState().redoEdit()).toBe(true);
    expect(useData.getState().model.subs[0].vals[0]).toBe(99);
  });
  it('空栈返回 false;新编辑清空重做栈', () => {
    expect(useData.getState().undoEdit()).toBe(false);
    expect(useData.getState().redoEdit()).toBe(false);
    useData.getState().updateCell(0, 0, 88);
    useData.getState().undoEdit();
    useData.getState().updateCell(0, 0, 77); // 新编辑后不可重做
    expect(useData.getState().redoEdit()).toBe(false);
  });
  it('删行可撤销(行数与文本列同步恢复)', () => {
    useData.getState().importMatrix('t', ['a'], [[1], [2], [3]], [{ name: 'g', values: ['x', 'y', 'z'] }]);
    useData.setState({ undoStack: [], redoStack: [] });
    useData.getState().deleteRow(1);
    expect(useData.getState().model.k).toBe(2);
    expect(useData.getState().textCols[0].values).toEqual(['x', 'z']);
    useData.getState().undoEdit();
    expect(useData.getState().model.k).toBe(3);
    expect(useData.getState().textCols[0].values).toEqual(['x', 'y', 'z']);
  });
});

describe('数据集命令', () => {
  it('新建工作表:5 列 × 3 行,名称唯一', () => {
    useData.getState().newWorksheet();
    const m = useData.getState().model;
    expect(m.name.startsWith('新建工作表_')).toBe(true);
    expect(m.n).toBe(5);
    expect(m.k).toBe(3);
  });
  it('另存为副本:数据一致,名称加后缀,进最近列表', () => {
    const before = useData.getState().model;
    const name = useData.getState().saveAsCopy();
    const after = useData.getState().model;
    expect(name).toContain('(副本');
    expect(after.name).toBe(name);
    expect(after.subs.map((s) => s.vals)).toEqual(before.subs.map((s) => s.vals));
    expect(useData.getState().recents[0].name).toBe(name);
  });
  it('标准化:各列均值≈0 标准差≈1', () => {
    const name = useData.getState().standardize();
    expect(name).toContain('(标准化)');
    const m = useData.getState().model;
    for (let j = 0; j < m.n; j++) {
      const v = m.subs.map((s) => s.vals[j]);
      const mu = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / (v.length - 1));
      expect(Math.abs(mu)).toBeLessThan(1e-3);
      expect(sd).toBeCloseTo(1, 2);
    }
  });
  it('生成随机数据:形状与名称正确,均值接近 μ', () => {
    useData.getState().generateRandom(50, 2, 30, 4);
    const m = useData.getState().model;
    expect(m.k).toBe(30);
    expect(m.n).toBe(4);
    expect(m.name).toBe('随机数据 N(50,2)');
    expect(Math.abs(m.oMean - 50)).toBeLessThan(1.5);
  });
  it('排序:按列升序,文本列同步,可撤销', () => {
    useData.getState().importMatrix('t', ['a'], [[3], [1], [2]], [{ name: 'g', values: ['c', 'a', 'b'] }]);
    useData.setState({ undoStack: [], redoStack: [] });
    useData.getState().sortBy(0, true);
    expect(useData.getState().model.subs.map((s) => s.vals[0])).toEqual([1, 2, 3]);
    expect(useData.getState().textCols[0].values).toEqual(['a', 'b', 'c']);
    useData.getState().undoEdit();
    expect(useData.getState().model.subs.map((s) => s.vals[0])).toEqual([3, 1, 2]);
  });
});
