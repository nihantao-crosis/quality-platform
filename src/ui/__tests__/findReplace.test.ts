/**
 * 查找/替换 — 计数、替换、列限定、显示精度容差、撤销。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useData } from '../../store/dataStore';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useData.getState().importMatrix('t.csv', ['a', 'b'], [
    [1.5, 2.0],
    [2.0, 1.5],
    [1.5, 1.5],
  ]);
});

describe('查找/替换', () => {
  it('replace=null 只计数不修改', () => {
    const n = useData.getState().findReplace(1.5, null, -1);
    expect(n).toBe(4);
    expect(useData.getState().model.subs[0].vals).toEqual([1.5, 2.0]);
  });
  it('全列替换并计数', () => {
    const n = useData.getState().findReplace(1.5, 9.9, -1);
    expect(n).toBe(4);
    const m = useData.getState().model;
    expect(m.subs.map((s) => s.vals)).toEqual([[9.9, 2.0], [2.0, 9.9], [9.9, 9.9]]);
  });
  it('限定列替换', () => {
    const n = useData.getState().findReplace(1.5, 9.9, 1); // 仅 b 列
    expect(n).toBe(2);
    const m = useData.getState().model;
    expect(m.subs.map((s) => s.vals)).toEqual([[1.5, 2.0], [2.0, 9.9], [1.5, 9.9]]);
  });
  it('按 3 位小数显示容差匹配', () => {
    useData.getState().importMatrix('p.csv', ['x'], [[25.0370001], [25.036], [25.037]]);
    const n = useData.getState().findReplace(25.037, 25.0, -1);
    expect(n).toBe(2); // 25.0370001 与 25.037 命中,25.036 不命中
  });
  it('无命中返回 0 不产生编辑', () => {
    const before = useData.getState().undoStack.length;
    expect(useData.getState().findReplace(42, 1, -1)).toBe(0);
    expect(useData.getState().undoStack.length).toBe(before);
  });
  it('替换可撤销', () => {
    useData.getState().findReplace(1.5, 9.9, -1);
    expect(useData.getState().undoEdit()).toBe(true);
    expect(useData.getState().model.subs[0].vals).toEqual([1.5, 2.0]);
  });
});
