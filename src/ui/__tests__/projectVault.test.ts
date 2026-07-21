/**
 * .qproj × 数据集库整合 — 导出嵌入 vault / 导入恢复 / 去重 / Web 跳过 / 旧格式兼容。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyProjectJson, applyProjectText, buildProjectJson, buildProjectJsonFull, exportProject } from '../../platform/project';
import { platform, type DatasetDb } from '../../platform/adapter';
import { MAX_QPROJ_IMPORT_BYTES } from '../../platform/importLimits';

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

function datasetJson(name: string, value: number): string {
  return JSON.stringify({
    name, colNames: ['C1'], rows: [[value], [value + 1]], textCols: [], savedAt: 't',
  });
}

function specsJson(name: string, shift = 0): string {
  return JSON.stringify({ [name]: { lsl: shift + 1, tgt: shift + 2, usl: shift + 3 } });
}

let fake: ReturnType<typeof fakeDb>;

beforeEach(() => {
  localStorage.clear();
  fake = fakeDb();
  platform.datasetDb = fake.db;
});
afterEach(() => {
  platform.datasetDb = null;
  vi.restoreAllMocks();
});

describe('.qproj × 数据集库', () => {
  it('导出嵌入库数据集;最近列表已带全量的不重复嵌入', async () => {
    fake.store.set('超大集', datasetJson('超大集', 1));
    fake.store.set('普通集', datasetJson('普通集', 2));
    localStorage.setItem('qp-recents-v1', JSON.stringify([
      { name: '普通集', savedAt: 't', data: JSON.parse(datasetJson('普通集', 2)) }, // 已带全量 → 不嵌入
      { name: '超大集', savedAt: 't' },                        // 轻量条目 → 嵌入
    ]));
    const file = JSON.parse(await buildProjectJsonFull('9.9.9'));
    expect(file.vault).toBeDefined();
    expect(Object.keys(file.vault)).toEqual(['超大集']);
    expect(file.formatVersion).toBe(4); // 旧读取器必须明确拒绝，不能静默忽略 vault/AQL 或 v7 快照新语义
  });

  it('多个本机归档在元数据预判已超过可再导入上限时，拒绝读入大字符串且不创建导出任务', async () => {
    localStorage.setItem('qp-specs-v1', '{}');
    const get = vi.fn(async () => datasetJson('归档A', 1));
    platform.datasetDb = {
      ...fake.db,
      async list() {
        return [
          { name: '归档A', saved_at: 't', bytes: Math.floor(MAX_QPROJ_IMPORT_BYTES * 0.6) },
          { name: '归档B', saved_at: 't', bytes: Math.floor(MAX_QPROJ_IMPORT_BYTES * 0.6) },
        ];
      },
      get,
    };
    const exportFile = vi.spyOn(platform, 'exportFile');

    const attempt = exportProject('9.9.9', '超大项目');
    await expect(attempt).rejects.toThrow('预计至少');
    await expect(attempt).rejects.toThrow('删除不再需要的本机归档数据集');
    expect(get).not.toHaveBeenCalled();
    expect(exportFile).not.toHaveBeenCalled();
  });

  it('导入把 vault 恢复进本机库并给出提示', async () => {
    const a = datasetJson('大集A', 1);
    const b = datasetJson('大集B', 2);
    const text = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': '{}' }, vault: { 大集A: a, 大集B: b },
    });
    const r = await applyProjectText(text);
    expect(r.error).toBeNull();
    expect(r.note).toContain('已恢复 2 个数据集');
    expect(fake.store.get('大集A')).toBe(a);
  });

  it('Web 端(无库)跳过 vault 并提示,stores 正常恢复', async () => {
    platform.datasetDb = null;
    const specs = specsJson('批次');
    const text = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': specs }, vault: { 大集: datasetJson('大集', 1) },
    });
    const r = await applyProjectText(text);
    expect(r.error).toBeNull();
    expect(r.note).toContain('仅桌面版可恢复');
    expect(localStorage.getItem('qp-specs-v1')).toBe(specs);
  });

  it('vault 内任一条目损坏会拒绝整个项目，且 stores 与库都不改写', async () => {
    const oldSpecs = specsJson('原规格');
    const oldGood = datasetJson('好', 10);
    localStorage.setItem('qp-specs-v1', oldSpecs);
    fake.store.set('好', oldGood);
    const text = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': specsJson('新规格', 10) }, vault: { 好: datasetJson('好', 20), 坏: '{not json' },
    });
    const r = await applyProjectText(text);
    expect(r.error).toContain('坏');
    expect(r.error).toContain('JSON 解析失败');
    expect(localStorage.getItem('qp-specs-v1')).toBe(oldSpecs);
    expect(fake.store.get('好')).toBe(oldGood);
    expect(fake.store.has('坏')).toBe(false);
  });

  it('旧 v1 格式(无 vault)照常导入；当前导出明确使用 v4', async () => {
    localStorage.setItem('qp-specs-v1', '{}');
    const legacy = buildProjectJson('1.0.0');
    expect(JSON.parse(legacy).formatVersion).toBe(4);
    const r = await applyProjectText(legacy);
    expect(r.error).toBeNull();
    expect(r.note).toBeUndefined();
  });

  it('完整导出读取 vault 失败时 fail-closed，不生成残缺项目', async () => {
    platform.datasetDb = {
      ...fake.db,
      async list() { throw new Error('disk offline'); },
    };
    await expect(buildProjectJsonFull('9.9.9')).rejects.toThrow('项目未导出');
    await expect(buildProjectJsonFull('9.9.9')).rejects.toThrow('disk offline');
  });

  it('vault 中途写入失败会明确报错，并回滚 stores 与已覆盖的库数据', async () => {
    const oldSpecs = specsJson('原规格');
    const oldA = datasetJson('大集A', 1);
    const oldB = datasetJson('大集B', 2);
    localStorage.setItem('qp-specs-v1', oldSpecs);
    fake.store.set('大集A', oldA);
    fake.store.set('大集B', oldB);
    let failOnce = true;
    platform.datasetDb = {
      ...fake.db,
      async put(name, json) {
        if (name === '大集B' && failOnce) {
          failOnce = false;
          throw new Error('write failed');
        }
        fake.store.set(name, json);
      },
    };
    const text = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': specsJson('新规格', 10) },
      vault: { 大集A: datasetJson('大集A', 11), 大集B: datasetJson('大集B', 12) },
    });

    const r = await applyProjectText(text);
    expect(r.error).toContain('写入本机数据集库失败');
    expect(r.error).toContain('原项目与数据集库已回滚');
    expect(localStorage.getItem('qp-specs-v1')).toBe(oldSpecs);
    expect(fake.store.get('大集A')).toBe(oldA);
    expect(fake.store.get('大集B')).toBe(oldB);
  });

  it('active-ref 随完整项目导出，且即使最近列表含全量副本也必须保留对应 vault', async () => {
    const name = '超配额活动集';
    const json = datasetJson(name, 30);
    fake.store.set(name, json);
    localStorage.setItem('qp-active-ref-v1', name);
    localStorage.setItem('qp-recents-v1', JSON.stringify([
      { name, savedAt: 't', data: JSON.parse(json) },
    ]));

    const file = JSON.parse(await buildProjectJsonFull('9.9.9'));
    expect(file.stores['qp-active-ref-v1']).toBe(name);
    expect(file.vault[name]).toBe(json);

    platform.datasetDb = null;
    await expect(buildProjectJsonFull('9.9.9')).rejects.toThrow('项目未导出');
  });

  it('active-ref 导入要求同名且内容一致的 vault 数据集，并在写入前拒绝悬空引用', async () => {
    const oldSpecs = specsJson('旧项目');
    localStorage.setItem('qp-specs-v1', oldSpecs);
    localStorage.setItem('qp-active-ref-v1', '旧机引用');
    const project = (vault: Record<string, string>) => JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': specsJson('新项目'), 'qp-active-ref-v1': '活动集' }, vault,
    });

    const missing = await applyProjectText(project({ 别的集: datasetJson('别的集', 1) }));
    expect(missing.error).toContain('没有对应数据集');
    expect(localStorage.getItem('qp-specs-v1')).toBe(oldSpecs);
    expect(localStorage.getItem('qp-active-ref-v1')).toBe('旧机引用');

    const mismatched = await applyProjectText(project({ 活动集: datasetJson('内容名不同', 2) }));
    expect(mismatched.error).toContain('名称与内容不一致');
    expect(localStorage.getItem('qp-specs-v1')).toBe(oldSpecs);
    expect(localStorage.getItem('qp-active-ref-v1')).toBe('旧机引用');
  });

  it('active-ref 有匹配 vault 时完整导入；Web 端则 fail-closed', async () => {
    const name = '活动集';
    const data = datasetJson(name, 40);
    const text = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-specs-v1': specsJson('新项目'), 'qp-active-ref-v1': name }, vault: { [name]: data },
    });

    expect(applyProjectJson(text)).toContain('完整项目导入');
    expect(localStorage.getItem('qp-active-ref-v1')).toBeNull();
    const desktop = await applyProjectText(text);
    expect(desktop.error).toBeNull();
    expect(localStorage.getItem('qp-active-ref-v1')).toBe(name);
    expect(fake.store.get(name)).toBe(data);

    localStorage.clear();
    platform.datasetDb = null;
    const web = await applyProjectText(text);
    expect(web.error).toContain('无法完整导入');
    expect(localStorage.getItem('qp-active-ref-v1')).toBeNull();
    expect(localStorage.getItem('qp-specs-v1')).toBeNull();
  });
});
