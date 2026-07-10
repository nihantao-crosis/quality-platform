/**
 * 本机数据集库(SQLite)前端接线 — 归档镜像(防抖)与 loadRecent 回落。
 * 用假 datasetDb 替换 platform.datasetDb 验证行为;Web 端(null)静默跳过。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useData } from '../../store/dataStore';
import { platform, type DatasetDb } from '../../platform/adapter';

function fakeDb() {
  const store = new Map<string, string>();
  const db: DatasetDb = {
    async put(name, json) { store.set(name, json); },
    async get(name) { return store.get(name) ?? null; },
    async list() { return [...store.entries()].map(([name, json]) => ({ name, saved_at: 't', bytes: json.length })); },
    async remove(name) { return store.delete(name); },
    async stats() { return { count: store.size, total_bytes: 0, path: ':memory:' }; },
  };
  return { db, store };
}

let fake: ReturnType<typeof fakeDb>;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  fake = fakeDb();
  platform.datasetDb = fake.db;
  useData.getState().resetDemo();
});

afterEach(() => {
  platform.datasetDb = null;
  vi.useRealTimers();
});

describe('归档镜像', () => {
  it('导入数据集 → 防抖后归档到库', async () => {
    useData.getState().importMatrix('产线A.csv', ['x'], [[1], [2], [3]]);
    expect(fake.store.has('产线A.csv')).toBe(false); // 防抖未到
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.store.has('产线A.csv')).toBe(true);
    const data = JSON.parse(fake.store.get('产线A.csv')!);
    expect(data.rows).toEqual([[1], [2], [3]]);
  });

  it('连续编辑只归档一次(尾随防抖)', async () => {
    useData.getState().importMatrix('t.csv', ['a', 'b'], [[1, 2], [3, 4], [5, 6]]);
    await vi.advanceTimersByTimeAsync(500);
    const putSpy = vi.spyOn(fake.db, 'put');
    useData.getState().updateCell(0, 0, 9);
    useData.getState().updateCell(0, 1, 8);
    useData.getState().updateCell(1, 0, 7);
    await vi.advanceTimersByTimeAsync(500);
    expect(putSpy).toHaveBeenCalledTimes(1);
    const data = JSON.parse(fake.store.get('t.csv')!);
    expect(data.rows[0]).toEqual([9, 8]);
    expect(data.rows[1][0]).toBe(7);
  });

  it('Web 端(datasetDb=null)不归档也不报错', async () => {
    platform.datasetDb = null;
    useData.getState().importMatrix('w.csv', ['x'], [[1], [2]]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.store.has('w.csv')).toBe(false);
  });
});

describe('loadRecent 回落数据集库', () => {
  it('不在最近列表时从库加载', async () => {
    fake.store.set('历史数据.csv', JSON.stringify({
      name: '历史数据.csv', colNames: ['直径'], rows: [[25.01], [24.99], [25.02]],
      textCols: [], savedAt: '2026-07-01T00:00:00Z',
    }));
    useData.setState({ recents: [] });
    useData.getState().loadRecent('历史数据.csv');
    await vi.advanceTimersByTimeAsync(10);
    expect(useData.getState().model.name).toBe('历史数据.csv');
    expect(useData.getState().model.all).toEqual([25.01, 24.99, 25.02]);
  });

  it('库中也没有时保持现状', async () => {
    const before = useData.getState().model.name;
    useData.setState({ recents: [] });
    useData.getState().loadRecent('不存在.csv');
    await vi.advanceTimersByTimeAsync(10);
    expect(useData.getState().model.name).toBe(before);
  });
});
