/**
 * 工作表列操作 — 重命名 / 删除 / 插入,及撤销栈覆盖列结构变化。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useData } from '../../store/dataStore';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useData.getState().importMatrix('t.csv', ['a', 'b', 'c'], [[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
});

describe('列操作', () => {
  it('重命名测量列', () => {
    useData.getState().renameColumn(1, '直径');
    expect(useData.getState().model.colNames).toEqual(['a', '直径', 'c']);
  });
  it('空名/同名不产生变更', () => {
    const before = useData.getState().model;
    useData.getState().renameColumn(0, '  ');
    useData.getState().renameColumn(0, 'a');
    expect(useData.getState().model).toBe(before);
  });
  it('删除测量列(n 减一,值同步)', () => {
    useData.getState().deleteColumn(1);
    const m = useData.getState().model;
    expect(m.colNames).toEqual(['a', 'c']);
    expect(m.n).toBe(2);
    expect(m.subs.map((s) => s.vals)).toEqual([[1, 3], [4, 6], [7, 9]]);
  });
  it('删到 n=1 转 I-MR;不可再删', () => {
    useData.getState().deleteColumn(0);
    useData.getState().deleteColumn(0);
    let m = useData.getState().model;
    expect(m.n).toBe(1);
    expect(m.hasSubgroups).toBe(false);
    useData.getState().deleteColumn(0); // 已达下限
    m = useData.getState().model;
    expect(m.n).toBe(1);
  });
  it('插入测量列(末列复制,可命名),上限 10', () => {
    useData.getState().insertColumn();
    const m = useData.getState().model;
    expect(m.n).toBe(4);
    expect(m.colNames[3]).toBe('测量4');
    expect(m.subs[0].vals).toEqual([1, 2, 3, 3]);
  });
  it('列操作可撤销(colNames 一并恢复)', () => {
    useData.getState().renameColumn(1, 'X');
    useData.getState().deleteColumn(2);
    expect(useData.getState().model.colNames).toEqual(['a', 'X']);
    useData.getState().undoEdit(); // 撤销删除
    expect(useData.getState().model.colNames).toEqual(['a', 'X', 'c']);
    useData.getState().undoEdit(); // 撤销重命名
    expect(useData.getState().model.colNames).toEqual(['a', 'b', 'c']);
    useData.getState().redoEdit(); // 重做重命名
    expect(useData.getState().model.colNames).toEqual(['a', 'X', 'c']);
  });
});
