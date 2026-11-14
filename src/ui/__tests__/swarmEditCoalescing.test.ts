/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';

describe('大表单格编辑持久化合并', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    cancelPendingDatasetWork();
  });

  afterEach(() => {
    cancelPendingDatasetWork();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('连续输入立即更新模型，但完整工作表只序列化落盘一次', () => {
    const writes: string[] = [];
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      writes.push(key);
      return original.call(this, key, value);
    });
    const rows = Array.from({ length: 20_000 }, (_, i) => [i]);
    useData.getState().importMatrix('合并编辑.csv', ['x'], rows);
    const before = writes.filter((key) => key === 'qp-dataset-v1').length;

    for (let i = 1; i <= 20; i++) useData.getState().updateCell(0, 0, i);
    expect(useData.getState().model.subs[0].vals[0]).toBe(20);
    expect(writes.filter((key) => key === 'qp-dataset-v1')).toHaveLength(before);
    expect(useData.getState().activeUnpersisted).toBe(true);

    vi.advanceTimersByTime(120);
    expect(writes.filter((key) => key === 'qp-dataset-v1')).toHaveLength(before + 1);
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).rows[0][0]).toBe(20);
    expect(useData.getState().activeUnpersisted).toBe(false);
  });

  it('合并窗口内立即撤销不会被旧 timer 覆盖', () => {
    useData.getState().importMatrix('撤销.csv', ['x'], [[1], [2], [3]]);
    useData.getState().updateCell(0, 0, 99);
    useData.getState().undoEdit();
    expect(useData.getState().model.subs[0].vals[0]).toBe(1);
    vi.runAllTimers();
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).rows[0][0]).toBe(1);
  });
});
