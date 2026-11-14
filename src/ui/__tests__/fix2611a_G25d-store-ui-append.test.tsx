/**
 * fix2611a G25d D2:appendSubgroup 校验失败不得推进数据集意图版本(否则在途的 loadRecent/vault 水合被静默作废)。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { platform, type DatasetDb } from '../../platform/adapter';
import { cancelPendingDatasetWork, settlePendingDatasetWrites, useData } from '../../store/dataStore';

function deferredDb(json: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const db: DatasetDb = {
    async put() { /* 不关心 */ },
    async insert() { return true; },
    async get() { await gate; return json; },
    async list() { return []; },
    async remove() { return true; },
    async clear(opId) { return { opId, committed: true, removed: 0 }; },
    async clearStatus() { return null; },
    async stats() { return { count: 0, total_bytes: 0, path: ':memory:' }; },
  };
  return { db, release };
}

const LIBRARY_NAME = '库中大表.csv';
const libraryJson = JSON.stringify({
  name: LIBRARY_NAME, colNames: ['x'], rows: [[1], [2], [3]], textCols: [], savedAt: '2026-11-01T00:00:00Z',
});

beforeEach(() => {
  localStorage.clear();
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  useData.getState().resetDemo();
  useData.setState({ recents: [{ name: LIBRARY_NAME, savedAt: '2026-11-01T00:00:00Z' }], mesRunning: false });
});

afterEach(async () => {
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
});

describe('D2 appendSubgroup 闸门在校验之后', () => {
  it('列数不匹配被拒时不作废在途的数据集库加载', async () => {
    const { db, release } = deferredDb(libraryJson);
    platform.datasetDb = db;
    const loading = useData.getState().loadRecent(LIBRARY_NAME);
    useData.setState({ mesRunning: true });
    const demoCols = useData.getState().model.colNames.length;
    useData.getState().appendSubgroup(Array.from({ length: demoCols + 1 }, () => 1));
    expect(useData.getState().mesRunning, '被拒追加仍须停流').toBe(false);
    release();
    await expect(loading).resolves.toBe(true);
    expect(useData.getState().model.name).toBe(LIBRARY_NAME);
  });

  it('目标表带文本列被拒时同样不作废在途加载', async () => {
    const { db, release } = deferredDb(libraryJson);
    platform.datasetDb = db;
    useData.setState({ textCols: [{ name: '组', values: useData.getState().model.subs.map(() => '甲') }] });
    const loading = useData.getState().loadRecent(LIBRARY_NAME);
    const demoCols = useData.getState().model.colNames.length;
    useData.getState().appendSubgroup(Array.from({ length: demoCols }, () => 1));
    release();
    await expect(loading).resolves.toBe(true);
    expect(useData.getState().model.name).toBe(LIBRARY_NAME);
  });

  it('合法追加仍推进意图(在途旧加载让位于新数据)', async () => {
    useData.getState().importMatrix('流.csv', ['a', 'b'], [[1, 2], [3, 4]]);
    const { db, release } = deferredDb(libraryJson);
    platform.datasetDb = db;
    const loading = useData.getState().loadRecent(LIBRARY_NAME);
    // loadRecent 过了替换闸门；模拟此后 MES 合法追加一组(MES 自身路径只推进意图)
    useData.getState().appendSubgroup([5, 6]);
    release();
    await expect(loading).resolves.toBe(false);
  });
});
