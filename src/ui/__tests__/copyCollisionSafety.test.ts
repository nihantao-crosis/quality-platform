/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb } from '../../platform/adapter';
import { buildProjectJsonFull } from '../../platform/project';
import {
  archiveToVault, cancelPendingDatasetWork, quiescePendingDatasetWorkForClear,
  settlePendingDatasetWrites, useData,
} from '../../store/dataStore';
import { useApp } from '../../store/appStore';

const jsonFor = (name: string, rows = [[91, 92], [93, 94]]) => JSON.stringify({
  name, colNames: ['x', 'y'], rows, textCols: [], savedAt: '2000-01-01T00:00:00.000Z',
});

function memoryDb(store = new Map<string, string>()) {
  const db: DatasetDb = {
    put: vi.fn(async (name, json) => {
      if (!store.has(name) && store.size >= 1000) throw new Error('本机库已达到 1000 条上限');
      store.set(name, json);
    }),
    insert: vi.fn(async (name, json) => {
      if (store.has(name)) return false;
      if (store.size >= 1000) throw new Error('本机库已达到 1000 条上限');
      store.set(name, json);
      return true;
    }),
    get: vi.fn(async (name) => store.get(name) ?? null),
    list: vi.fn(async () => [...store.entries()].reverse().slice(0, 1000)
      .map(([name, json]) => ({ name, bytes: json.length, saved_at: 't' }))),
    remove: vi.fn(async (name) => store.delete(name)),
    async clear(opId) { const removed = store.size; store.clear(); return { opId, committed: true, removed }; },
    async clearStatus() { return null; },
    async stats() { return { count: store.size, total_bytes: 0, path: ':memory:' }; },
  };
  return { db, store };
}

beforeEach(() => {
  vi.useFakeTimers();
  platform.datasetDb = null;
  localStorage.clear();
  cancelPendingDatasetWork();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useData.getState().importMatrix('Legacy', ['x', 'y'], [[1, 2], [3, 4]]);
});

afterEach(async () => {
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('自动副本原子只插入', () => {
  it('1001 条历史库中隐藏的同名副本不被覆盖，满库失败也不更改活动槽/recent', async () => {
    const oldName = 'Legacy (副本)';
    const oldJson = jsonFor(oldName);
    const fake = memoryDb(new Map([[oldName, oldJson]]));
    for (let i = 0; i < 1000; i++) fake.store.set(`new-${i}`, jsonFor(`new-${i}`));
    platform.datasetDb = fake.db;
    expect(await fake.db.list()).toHaveLength(1000);
    expect((await fake.db.list()).some((entry) => entry.name === oldName)).toBe(false);
    localStorage.removeItem('qp-copy-sequences-v1');
    const beforeActive = localStorage.getItem('qp-dataset-v1');
    const beforeRecents = localStorage.getItem('qp-recents-v1');

    const copy = useData.getState().saveAsCopy();
    await expect(copy.outcome.durability).rejects.toThrow('1000 条上限');
    expect(fake.store.get(oldName)).toBe(oldJson);
    expect(fake.store.size).toBe(1001);
    expect(fake.db.insert).toHaveBeenCalledTimes(2);
    expect(fake.db.put).not.toHaveBeenCalled();
    expect(useData.getState().model.name).toBe('Legacy');
    expect(localStorage.getItem('qp-dataset-v1')).toBe(beforeActive);
    expect(localStorage.getItem('qp-recents-v1')).toBe(beforeRecents);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.db.put).not.toHaveBeenCalled();
  });

  it('候选名称碰撞后换名，只在独立插入成功后激活，并允许后续普通编辑更新副本', async () => {
    const oldName = 'Legacy (副本)';
    const oldJson = jsonFor(oldName);
    const fake = memoryDb(new Map([[oldName, oldJson]]));
    platform.datasetDb = fake.db;
    const copy = useData.getState().saveAsCopy();
    expect(useData.getState().model.name).toBe('Legacy');
    await expect(copy.outcome.durability).resolves.toBeUndefined();
    expect(copy.name).toBe('Legacy (副本2)');
    expect(useData.getState().model.name).toBe(copy.name);
    expect(JSON.parse(fake.store.get(copy.name)!).rows).toEqual([[1, 2], [3, 4]]);
    expect(fake.store.get(oldName)).toBe(oldJson);
    expect(fake.db.put).not.toHaveBeenCalled();
    useData.getState().updateCell(0, 0, 55);
    await vi.advanceTimersByTimeAsync(500);
    await settlePendingDatasetWrites();
    expect(fake.db.put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fake.store.get(copy.name)!).rows[0][0]).toBe(55);
    expect(fake.store.get(oldName)).toBe(oldJson);
  });

  it('创建失败不会进入普通 upsert 重试队列，之后导出也不覆盖候选旧名', async () => {
    const fake = memoryDb();
    fake.db.insert = vi.fn(async () => { throw new Error('disk full'); });
    platform.datasetDb = fake.db;
    const copy = useData.getState().saveAsCopy();
    await expect(copy.outcome.durability).rejects.toThrow('disk full');
    fake.store.set(copy.name, jsonFor(copy.name));
    await buildProjectJsonFull('1.43.0');
    expect(fake.db.put).not.toHaveBeenCalled();
    expect(JSON.parse(fake.store.get(copy.name)!).rows).toEqual([[91, 92], [93, 94]]);
  });

  it('等待插入期间的新编辑不被旧副本激活覆盖', async () => {
    let finish!: () => void;
    const fake = memoryDb();
    fake.db.insert = vi.fn((name, json) => new Promise<boolean>((resolve) => {
      finish = () => { fake.store.set(name, json); resolve(true); };
    }));
    platform.datasetDb = fake.db;
    const copy = useData.getState().saveAsCopy();
    await Promise.resolve();
    useData.getState().updateCell(0, 0, 99);
    finish();
    await expect(copy.outcome.durability).rejects.toThrow('未切换当前数据');
    expect(useData.getState().model.name).toBe('Legacy');
    expect(useData.getState().model.subs[0].vals[0]).toBe(99);
    expect(JSON.parse(fake.store.get(copy.name)!).rows[0][0]).toBe(1);
  });

  it('清库等待包含完整副本管线，碰撞的迟到结果不能在清库后继续重试', async () => {
    let finish!: (inserted: boolean) => void;
    const fake = memoryDb();
    fake.db.insert = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    platform.datasetDb = fake.db;
    const copy = useData.getState().saveAsCopy();
    await Promise.resolve();
    const clearing = quiescePendingDatasetWorkForClear();
    finish(false);
    await expect(copy.outcome.durability).rejects.toThrow('已取消副本切换');
    await clearing;
    cancelPendingDatasetWork();
    expect(fake.db.insert).toHaveBeenCalledTimes(1);
    expect(fake.db.put).not.toHaveBeenCalled();
    expect(useData.getState().model.name).toBe('Legacy');
  });

  it('不支持原子插入的旧适配器明确拒绝，不降级为 get+put', () => {
    const fake = memoryDb();
    delete fake.db.insert;
    platform.datasetDb = fake.db;
    const copy = useData.getState().saveAsCopy();
    expect(copy.outcome.rejected).toContain('不支持安全创建副本');
    expect(copy.outcome.archiving).toBe(false);
    expect(useData.getState().model.name).toBe('Legacy');
    expect(fake.db.put).not.toHaveBeenCalled();
    expect(fake.db.get).not.toHaveBeenCalled();
  });

  it('演示表首次编辑的隐藏同名碰撞不会 upsert，当前矩阵和只插入标记保留', async () => {
    useData.getState().resetDemo();
    const oldName = '质检数据 (副本)';
    const oldJson = jsonFor(oldName);
    const fake = memoryDb(new Map([[oldName, oldJson]]));
    platform.datasetDb = fake.db;
    useData.getState().updateCell(0, 0, 77);
    await vi.advanceTimersByTimeAsync(500);
    await settlePendingDatasetWrites();
    expect(fake.store.get(oldName)).toBe(oldJson);
    expect(fake.db.put).not.toHaveBeenCalled();
    expect(useData.getState().model.subs[0].vals[0]).toBe(77);
    expect(useApp.getState().toast).toContain('另存为副本');
    const retained = JSON.parse(localStorage.getItem('qp-dataset-v1')!);
    expect(retained.vaultInsertOnly).toBe(true);

    // 模拟重启：清空模块会话保护，重新装入磁盘快照；保护由载荷恢复，不能靠 Set。
    cancelPendingDatasetWork();
    useData.setState({ recents: [{ name: retained.name, savedAt: retained.savedAt, data: retained }] });
    useData.getState().resetDemo();
    expect(await useData.getState().loadRecent(retained.name)).toBe(true);
    useData.getState().updateCell(0, 0, 88);
    await vi.advanceTimersByTimeAsync(500);
    await settlePendingDatasetWrites();
    expect(fake.store.get(oldName)).toBe(oldJson);
    expect(fake.db.put).not.toHaveBeenCalled();
    expect(useData.getState().model.subs[0].vals[0]).toBe(88);
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).vaultInsertOnly).toBe(true);
  });

  it('演示副本首次创建成功后清除本地保护标记，后续编辑可更新自己的记录', async () => {
    useData.getState().resetDemo();
    const fake = memoryDb();
    platform.datasetDb = fake.db;
    useData.getState().updateCell(0, 0, 77);
    await vi.advanceTimersByTimeAsync(500);
    await settlePendingDatasetWrites();
    const name = useData.getState().model.name;
    expect(fake.db.insert).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).vaultInsertOnly).toBeUndefined();
    expect(JSON.parse(fake.store.get(name)!).vaultInsertOnly).toBeUndefined();
    useData.getState().updateCell(0, 0, 88);
    await vi.advanceTimersByTimeAsync(500);
    await settlePendingDatasetWrites();
    expect(fake.db.put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fake.store.get(name)!).rows[0][0]).toBe(88);
  });

  it('创建成功但本地确认标记未清除即重启时保守拒绝，不把未知同名记录当作已拥有', async () => {
    const name = '重启副本';
    const pending = { ...JSON.parse(jsonFor(name, [[1, 2], [3, 4]])), vaultInsertOnly: true as const };
    const fake = memoryDb(new Map([[name, jsonFor(name, [[1, 2], [3, 4]])]]));
    platform.datasetDb = fake.db;
    archiveToVault(pending);
    await vi.advanceTimersByTimeAsync(500);
    await settlePendingDatasetWrites();
    expect(fake.db.insert).toHaveBeenCalledTimes(1);
    expect(fake.db.put).not.toHaveBeenCalled();
    expect(useApp.getState().toast).toContain('导出 CSV 备份');
  });

  it('演示副本碰撞后按提示换名另存可恢复完整项目导出，旧真实库记录不再被 recent 掩盖', async () => {
    useData.getState().resetDemo();
    const oldName = '质检数据 (副本)';
    const oldJson = jsonFor(oldName);
    const fake = memoryDb(new Map([[oldName, oldJson]]));
    platform.datasetDb = fake.db;
    useData.getState().updateCell(0, 0, 77);
    await vi.advanceTimersByTimeAsync(500);
    await settlePendingDatasetWrites();
    // 更晚编辑仍保留在源 timer；旧失败版本由最新成功副本替代，不能继续阻断导出。
    useData.getState().updateCell(0, 0, 88);
    const copy = useData.getState().saveAsCopy();
    await expect(copy.outcome.durability).resolves.toBeUndefined();
    expect(useData.getState().model.name).toBe(copy.name);
    expect(useData.getState().recents.some((entry) => entry.name === oldName)).toBe(false);
    expect(JSON.parse(fake.store.get(copy.name)!).rows[0][0]).toBe(88);
    const exported = JSON.parse(await buildProjectJsonFull('1.43.0'));
    expect(exported.vault[oldName]).toBe(oldJson);
    expect(fake.store.get(oldName)).toBe(oldJson);
    expect(fake.db.put).not.toHaveBeenCalled();
    expect(await useData.getState().loadRecent(oldName)).toBe(true);
    expect(useData.getState().model.subs[0].vals).toEqual([91, 92]);
  });

  it('换名保存等待旧候选在途写入落定，不让迟到失败重建已退休义务', async () => {
    useData.getState().resetDemo();
    const oldName = '质检数据 (副本)';
    const oldJson = jsonFor(oldName);
    const fake = memoryDb(new Map([[oldName, oldJson]]));
    let finishOld!: () => void;
    fake.db.insert = vi.fn((name, json) => name === oldName
      ? new Promise<boolean>((resolve) => { finishOld = () => resolve(false); })
      : Promise.resolve().then(() => { fake.store.set(name, json); return true; }));
    platform.datasetDb = fake.db;
    useData.getState().updateCell(0, 0, 77);
    await vi.advanceTimersByTimeAsync(500);
    const copy = useData.getState().saveAsCopy();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(useData.getState().model.name).toBe(oldName);
    finishOld();
    await expect(copy.outcome.durability).resolves.toBeUndefined();
    await expect(buildProjectJsonFull('1.43.0')).resolves.toContain(copy.name);
    expect(fake.store.get(oldName)).toBe(oldJson);
    expect(fake.db.put).not.toHaveBeenCalled();
  });

  it('退休旧候选只作用于该源表，不能清除另一数据集的失败保全义务', async () => {
    useData.getState().resetDemo();
    const oldName = '质检数据 (副本)';
    const fake = memoryDb(new Map([[oldName, jsonFor(oldName)]]));
    fake.db.put = vi.fn(async () => { throw new Error('另一数据集仍未保存'); });
    platform.datasetDb = fake.db;
    archiveToVault(JSON.parse(jsonFor('另一数据集')));
    useData.getState().updateCell(0, 0, 77);
    await vi.advanceTimersByTimeAsync(500);
    await settlePendingDatasetWrites();
    const copy = useData.getState().saveAsCopy();
    await expect(copy.outcome.durability).resolves.toBeUndefined();
    await expect(buildProjectJsonFull('1.43.0')).rejects.toThrow('另一数据集仍未保存');
    expect(fake.db.put).toHaveBeenLastCalledWith('另一数据集', expect.any(String));
  });
});
