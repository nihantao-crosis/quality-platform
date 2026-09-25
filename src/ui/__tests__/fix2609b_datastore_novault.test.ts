/**
 * fix2609b · G4b-datastore M1 / PLATFORM-01 回归：不带 vault 字段的 .qproj(Web 端导出、或 vault 引入前的
 * 旧版桌面导出)在桌面端打开后，最近列表里带全量数据的条目从未写入本机库；此后被新导入挤出最近列表时
 * 必须补入本机库，兑现「移出最近列表的数据集仍可在库中找回」。
 * 端到端走真实生产函数：Web 端 buildProjectJson 导出 → 桌面端 applyProjectText 导入 → 模块重载模拟重启
 * → 连续导入 5 张新表 → loadRecent。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatasetDb } from '../../platform/adapter';

function memoryDb(store: Map<string, string>): DatasetDb {
  return {
    async put(name, json) { store.set(name, json); },
    async insert(name, json) { if (store.has(name)) return false; store.set(name, json); return true; },
    async get(name) { return store.get(name) ?? null; },
    async list() { return [...store.entries()].map(([name, json]) => ({ name, saved_at: 't', bytes: json.length })); },
    async remove(name) { return store.delete(name); },
    async clear(opId) { const removed = store.size; store.clear(); return { opId, committed: true, removed }; },
    async clearStatus() { return null; },
    async stats() { return { count: store.size, total_bytes: 0, path: ':memory:' }; },
  };
}

/** 模拟一次启动：丢弃模块状态后按顺序重新加载(与页面刷新后 main.tsx 的加载顺序一致)。 */
async function boot(db: DatasetDb | null) {
  vi.resetModules();
  const adapter = await import('../../platform/adapter');
  adapter.platform.datasetDb = db;
  const dataStore = await import('../../store/dataStore');
  const project = await import('../../platform/project');
  return { dataStore, project, useData: dataStore.useData };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); vi.resetModules(); });

describe('PLATFORM-01 无 vault 的 .qproj 在桌面端导入后的挤出保全', () => {
  it('导入后连续导入 5 张新表，loadRecent(\'网A\') 仍从本机库找回', async () => {
    const web = await boot(null);
    web.useData.getState().importMatrix('网A', ['x'], [[1], [2], [3]]);
    web.useData.getState().importMatrix('网B', ['x'], [[4], [5], [6]]);
    const text = web.project.buildProjectJson('1.43.0');
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(text), 'vault')).toBe(false);

    localStorage.clear();
    const store = new Map<string, string>();
    const db = memoryDb(store);
    const importer = await boot(db);
    const applied = await importer.project.applyProjectText(text);
    expect(applied.error).toBeNull();
    await importer.dataStore.settlePendingDatasetWrites();
    expect(store.has('网A')).toBe(false); // 无 vault 路径不写库：条目只在最近列表

    const desktop = await boot(db);
    expect(desktop.useData.getState().recents.map((entry) => entry.name)).toEqual(['网B', '网A']);
    for (let i = 1; i <= 5; i++) desktop.useData.getState().importMatrix(`新表${i}.csv`, ['x'], [[i], [i + 1]]);
    expect(desktop.useData.getState().recents.map((entry) => entry.name)).not.toContain('网A');
    await desktop.dataStore.settlePendingDatasetWrites();
    expect(await desktop.useData.getState().loadRecent('网A')).toBe(true);
    expect(desktop.useData.getState().model.subs.map((s) => s.vals)).toEqual([[1], [2], [3]]);
    expect(await desktop.useData.getState().loadRecent('网B')).toBe(true);
    expect(desktop.useData.getState().model.subs.map((s) => s.vals)).toEqual([[4], [5], [6]]);
    await desktop.dataStore.settlePendingDatasetWrites();
    desktop.dataStore.cancelPendingDatasetWork();
  });
});
