/** 本地缓存损坏时，运行时恢复必须与 .qproj 导入使用同一结构校验。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadValidatedStoreJson, useData } from '../../store/dataStore';
import { useSessionLog } from '../../store/sessionLog';
import { useApp } from '../../store/appStore';

beforeEach(() => {
  localStorage.clear();
  useSessionLog.getState().clear();
});

describe('本地缓存启动隔离', () => {
  it('合法数据集可恢复', () => {
    const stored = {
      name: '有效数据.csv', colNames: ['测量值'], rows: [[1], [2]], textCols: [], savedAt: '2026-07-15T00:00:00Z',
    };
    localStorage.setItem('qp-dataset-v1', JSON.stringify(stored));
    expect(loadValidatedStoreJson('qp-dataset-v1')).toEqual(stored);
  });

  it('矩阵截断、错误类型和坏副本序号均被隔离，且不静默删除原值', () => {
    const cases: Array<[string, unknown]> = [
      ['qp-dataset-v1', {
        name: '坏数据.csv', colNames: ['C1', 'C2'], rows: [[1, 2], [3]], textCols: [], savedAt: 't',
      }],
      ['qp-recents-v1', { 0: { name: '伪数组' } }],
      ['qp-attr-v1', { p: { name: 'P', counts: [1, 2], sampleSizes: [10] } }],
      ['qp-pareto-v1', { name: 'P', rows: [{ name: '划伤', count: -1 }] }],
      ['qp-specs-v1', { A: { lsl: 1, tgt: '2', usl: 3 } }],
      ['qp-copy-sequences-v1', { A: 0 }],
    ];
    for (const [key, value] of cases) {
      const encoded = JSON.stringify(value);
      localStorage.setItem(key, encoded);
      expect(loadValidatedStoreJson(key), key).toBeNull();
      expect(localStorage.getItem(key), key).toBe(encoded);
      expect(JSON.parse(localStorage.getItem('qp-quarantine-v1')!)[key].raw, key).toBe(encoded);
    }
    expect(useSessionLog.getState().entries.some((entry) => entry.includes('已隔离损坏的本地存储'))).toBe(true);
  });

  it('截断 JSON 不抛异常', () => {
    localStorage.setItem('qp-dataset-v1', '{"name":"未写完"');
    expect(() => loadValidatedStoreJson('qp-dataset-v1')).not.toThrow();
    expect(loadValidatedStoreJson('qp-dataset-v1')).toBeNull();
  });

  it('隔离区因配额失败时写保护原值；空间释放后先隔离再允许覆盖', () => {
    const corrupt = '{"name":"未写完"';
    localStorage.setItem('qp-dataset-v1', corrupt);
    const originalSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'qp-quarantine-v1') throw new DOMException('quota', 'QuotaExceededError');
      return originalSetItem.call(this, key, value);
    });
    try {
      expect(loadValidatedStoreJson('qp-dataset-v1')).toBeNull();
      useData.getState().importMatrix('新数据.csv', ['x'], [[10], [20]]);
      expect(localStorage.getItem('qp-dataset-v1')).toBe(corrupt);
      expect(useApp.getState().toast).toContain('禁止覆盖原值');
    } finally {
      spy.mockRestore();
    }

    useData.getState().importMatrix('新数据.csv', ['x'], [[10], [20]]);
    expect(JSON.parse(localStorage.getItem('qp-quarantine-v1')!)['qp-dataset-v1'].raw).toBe(corrupt);
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).rows).toEqual([[10], [20]]);
  });
});
