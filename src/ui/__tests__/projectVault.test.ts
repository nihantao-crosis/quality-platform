/**
 * .qproj × 数据集库整合 — 导出嵌入 vault / 导入恢复 / 去重 / Web 跳过 / 旧格式兼容。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildProjectJson, buildProjectJsonFull, applyProjectText } from '../../platform/project';
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
  fake = fakeDb();
  platform.datasetDb = fake.db;
});
afterEach(() => { platform.datasetDb = null; });

describe('.qproj × 数据集库', () => {
  it('导出嵌入库数据集;最近列表已带全量的不重复嵌入', async () => {
    fake.store.set('超大集', '{"rows":[[1]]}');
    fake.store.set('普通集', '{"rows":[[2]]}');
    localStorage.setItem('qp-recents-v1', JSON.stringify([
      { name: '普通集', savedAt: 't', data: { rows: [[2]] } }, // 已带全量 → 不嵌入
      { name: '超大集', savedAt: 't' },                        // 轻量条目 → 嵌入
    ]));
    const file = JSON.parse(await buildProjectJsonFull('9.9.9'));
    expect(file.vault).toBeDefined();
    expect(Object.keys(file.vault)).toEqual(['超大集']);
    expect(file.formatVersion).toBe(1); // 向后兼容,不升版本
  });

  it('导入把 vault 恢复进本机库并给出提示', async () => {
    const text = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
      stores: {}, vault: { 大集A: '{"rows":[[1]]}', 大集B: '{"rows":[[2]]}' },
    });
    const r = await applyProjectText(text);
    expect(r.error).toBeNull();
    expect(r.note).toContain('已恢复 2 个数据集');
    expect(fake.store.get('大集A')).toBe('{"rows":[[1]]}');
  });

  it('Web 端(无库)跳过 vault 并提示,stores 正常恢复', async () => {
    platform.datasetDb = null;
    const text = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': '{"a":1}' }, vault: { 大集: '{"rows":[[1]]}' },
    });
    const r = await applyProjectText(text);
    expect(r.error).toBeNull();
    expect(r.note).toContain('仅桌面版可恢复');
    expect(localStorage.getItem('qp-specs-v1')).toBe('{"a":1}');
  });

  it('vault 内损坏条目跳过,合法条目照常入库', async () => {
    const text = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
      stores: {}, vault: { 好: '{"ok":1}', 坏: '{not json' },
    });
    const r = await applyProjectText(text);
    expect(r.note).toContain('已恢复 1 个数据集');
    expect(fake.store.has('坏')).toBe(false);
  });

  it('旧格式(无 vault)照常导入;新文件在旧读取器语义下仍是 formatVersion 1', async () => {
    const legacy = buildProjectJson('1.0.0');
    const r = await applyProjectText(legacy);
    expect(r.error).toBeNull();
    expect(r.note).toBeUndefined();
  });
});
