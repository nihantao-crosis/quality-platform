/**
 * fix2609m · G23a-store 回归(最终对抗复审 P2)：
 * - A1 dropStaleActiveSlot 只删本窗口自己写入/启动读入的 LS_DATASET 原文；另一窗口刚写入的同名更新版本
 *   必须保留(两窗口 = vi.resetModules 各自加载的真实 dataStore 实例，共享 jsdom localStorage)。
 *   附 G15 复审 P3：删槽后内存活动表须重新登记为导出覆盖项，立即导出项目不缺 qp-dataset-v1(写读对称)。
 * - A3 PLATFORM-05 导出侧：启动后不经任何页面读取(懒加载键未被触达)直接保存项目，损坏键先按读取侧同一函数
 *   隔离、再按降级视图导出；隔离失败仍 fail-closed，文案给出释放空间的出路。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const RECENTS = 'qp-recents-v1';
const DATASET = 'qp-dataset-v1';
const QUARANTINE = 'qp-quarantine-v1';
type DataStoreModule = typeof import('../../store/dataStore');

const nativeSetItem = Storage.prototype.setItem;
const nativeRemoveItem = Storage.prototype.removeItem;
const queue: Array<{ key: string; newValue: string | null }> = [];
let quota: number | null = null;
let failQuarantineWrites = false;

function usedExcept(storage: Storage, skip: string): number {
  let total = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!;
    if (key === skip) continue;
    total += key.length + (storage.getItem(key) ?? '').length;
  }
  return total;
}

async function openWindow(): Promise<DataStoreModule> {
  vi.resetModules();
  const adapter = await import('../../platform/adapter');
  adapter.platform.datasetDb = null;
  return import('../../store/dataStore');
}

/** 把排队的 localStorage 写入按真实 StorageEvent 投递给(所有)已加载窗口的监听器。 */
function deliver(): void {
  for (let n = 0; queue.length > 0 && n < 60; n++) {
    const event = queue.shift()!;
    window.dispatchEvent(new StorageEvent('storage', { key: event.key, newValue: event.newValue, storageArea: localStorage }));
  }
}

function rowsOf(key: string, name: string): number[][] | undefined {
  const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
  if (Array.isArray(parsed)) {
    return (parsed as Array<{ name: string; data?: { rows: number[][] } }>).find((entry) => entry.name === name)?.data?.rows;
  }
  const single = parsed as { name?: string; rows?: number[][] } | null;
  return single?.name === name ? single.rows : undefined;
}

async function setCells(w: DataStoreModule, cells: Array<[number, number, number]>): Promise<void> {
  vi.useFakeTimers();
  for (const [row, col, value] of cells) w.useData.getState().updateCell(row, col, value);
  await vi.runAllTimersAsync();
  vi.useRealTimers();
}

/** 编辑值比原值多 17 个字符/格。 */
const LONG = 1.2345678901234567;
const BASE = [[1], [2], [3], [4], [5], [6], [7]];
const EDITED = BASE.map(() => [LONG]);

beforeEach(() => {
  localStorage.clear();
  queue.length = 0;
  quota = null;
  failQuarantineWrites = false;
  Storage.prototype.setItem = function quotaLimited(this: Storage, key: string, value: string) {
    if (failQuarantineWrites && key.startsWith(QUARANTINE)) throw new DOMException('quota', 'QuotaExceededError');
    if (quota !== null && usedExcept(this, key) + key.length + value.length > quota) {
      throw new DOMException('quota', 'QuotaExceededError');
    }
    nativeSetItem.call(this, key, value);
    queue.push({ key, newValue: value });
  };
  Storage.prototype.removeItem = function tracked(this: Storage, key: string) {
    nativeRemoveItem.call(this, key);
    queue.push({ key, newValue: null });
  };
});

afterEach(() => {
  Storage.prototype.setItem = nativeSetItem;
  Storage.prototype.removeItem = nativeRemoveItem;
  vi.useRealTimers();
  localStorage.clear();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function seedXZ(): Promise<DataStoreModule> {
  const w = await openWindow();
  w.useData.getState().importMatrix('Z.csv', ['x'], [[8], [9]]);
  w.useData.getState().importMatrix('X.csv', ['x'], BASE);
  expect(w.useData.getState().model.name).toBe('X.csv');
  queue.length = 0;
  return w;
}

describe('A1 dropStaleActiveSlot 只删本窗口自己的旧写入', () => {
  it('两窗口同表：W1 编辑写不下 → W2 等长编辑落盘 → W1 × 移除 Z，槽保留 W2 版本，刷新后仍是 W2 版本', async () => {
    const w1 = await seedXZ();
    const w2 = await openWindow();
    expect(w2.useData.getState().model.name).toBe('X.csv');
    quota = usedExcept(localStorage, '');

    await setCells(w1, BASE.map((_, row) => [row, 0, LONG] as [number, number, number]));
    expect(w1.useData.getState().recentsUnpersisted).toBe(true);

    await setCells(w2, [[0, 0, 9]]);
    const w2Version = [[9], ...BASE.slice(1)];
    expect(rowsOf(DATASET, 'X.csv')).toEqual(w2Version);
    expect(w2.useData.getState().activeUnpersisted).toBe(false);
    deliver();

    w1.useData.getState().removeRecent('Z.csv');
    // 槽里是 W2 刚写入的更新版本(不是 W1 自己的旧写入)：不得删除
    expect(rowsOf(DATASET, 'X.csv')).toEqual(w2Version);
    deliver();
    expect(rowsOf(DATASET, 'X.csv')).toEqual(w2Version);

    // W2 刷新
    const w3 = await openWindow();
    expect(w3.useData.getState().model.name).toBe('X.csv');
    expect(w3.useData.getState().model.subs.map((subgroup) => subgroup.vals)).toEqual(w2Version);
  });

  it('对照：单窗口槽里是本窗口自己的旧写入时照常删除(G15 修复不回退)', async () => {
    const w1 = await seedXZ();
    quota = usedExcept(localStorage, '');
    await setCells(w1, BASE.map((_, row) => [row, 0, LONG] as [number, number, number]));
    w1.useData.getState().removeRecent('Z.csv');
    expect(localStorage.getItem(DATASET)).toBeNull();
    expect(rowsOf(RECENTS, 'X.csv')).toEqual(EDITED);
  });

  it('对照：启动读入的槽(本窗口未写过)同样算本窗口的旧副本，可删除', async () => {
    await seedXZ();
    const w1 = await openWindow(); // 「刷新」后的新实例：槽是启动读入的
    quota = usedExcept(localStorage, '');
    await setCells(w1, BASE.map((_, row) => [row, 0, LONG] as [number, number, number]));
    expect(w1.useData.getState().recentsUnpersisted).toBe(true);
    w1.useData.getState().removeRecent('Z.csv');
    expect(localStorage.getItem(DATASET)).toBeNull();
    expect(rowsOf(RECENTS, 'X.csv')).toEqual(EDITED);
  });

  it('G15 复审 P3：删槽后立即导出项目，qp-dataset-v1 为内存中的最新活动表(写读对称)', async () => {
    const w1 = await seedXZ();
    quota = usedExcept(localStorage, '');
    await setCells(w1, BASE.map((_, row) => [row, 0, LONG] as [number, number, number]));
    w1.useData.getState().removeRecent('Z.csv');
    expect(localStorage.getItem(DATASET)).toBeNull();

    const project = await import('../../platform/project');
    const file = JSON.parse(await project.buildProjectJsonFull('t')) as { stores: Record<string, string> };
    expect(file.stores[DATASET]).toBeDefined();
    const exported = JSON.parse(file.stores[DATASET]) as { name: string; rows: number[][] };
    expect(exported.name).toBe('X.csv');
    expect(exported.rows).toEqual(EDITED);
    // 离开拦截仍如实提示活动表只在内存
    expect(w1.hasUnpersistedState()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
/** 模拟应用启动：加载全部 store 模块，停在仪表盘，不进入任何页面、不调用任何读取函数。 */
async function boot(): Promise<typeof import('../../platform/project')> {
  vi.resetModules();
  const adapter = await import('../../platform/adapter');
  adapter.platform.datasetDb = null;
  const project = await import('../../platform/project');
  await import('../../store/appStore');
  await import('../../store/dataStore');
  await import('../../store/analyses');
  await import('../../store/fishboneStore');
  return project;
}

const CORRUPT_CASES: Array<[string, string]> = [
  ['qp-specs-v1', '{"a":{"lsl":"q"}}'],
  ['qp-fishbone-v1', '{"data":1,"isDemo":"x"}'],
  ['qp-copy-sequences-v1', '[]'],
  ['qp-attr-v1', '"x"'],
  ['qp-pareto-v1', '"x"'],
  ['qp-dataset-v1', '{"name":1}'],
  ['qp-recents-v1', '"x"'],
  ['qp-specs-v1', '{截断'],
  ['qp-fishbone-v1', '{截断'],
  ['qp-copy-sequences-v1', '{截断'],
];

describe('A3 启动后直接保存项目：懒加载键同样先隔离再降级', () => {
  it.each(CORRUPT_CASES)('%s = %s：不预先调用读取函数，导出成功且原文随隔离区带出', async (key, corrupt) => {
    localStorage.setItem(key, corrupt);
    const project = await boot();
    const file = JSON.parse(await project.buildProjectJsonFull('t')) as { stores: Record<string, string> };
    expect(file.stores[key]).toBeUndefined();
    const quarantine = JSON.parse(file.stores[QUARANTINE]) as Record<string, { raw: string }>;
    expect(quarantine[key].raw).toBe(corrupt);
    expect(project.getLastProjectExportDegradedStores()).toContain(key);
    // live 键原样保留(取证保底不被导出改写)
    expect(localStorage.getItem(key)).toBe(corrupt);
  });

  it.each([
    ['qp-specs-v1', '{"a":{"lsl":"q"}}'],
    ['qp-fishbone-v1', '{"data":1,"isDemo":"x"}'],
    ['qp-copy-sequences-v1', '[]'],
  ])('%s：隔离区写不下时仍 fail-closed，并给出释放空间的出路；释放后重试导出放行', async (key, corrupt) => {
    localStorage.setItem(key, corrupt);
    const project = await boot();
    failQuarantineWrites = true;
    await expect(project.buildProjectJsonFull('t')).rejects.toThrow(/项目未导出[\s\S]*最近数据集[\s\S]*释放/);
    expect(localStorage.getItem(key)).toBe(corrupt);
    failQuarantineWrites = false;
    const file = JSON.parse(await project.buildProjectJsonFull('t')) as { stores: Record<string, string> };
    expect(file.stores[key]).toBeUndefined();
    expect((JSON.parse(file.stores[QUARANTINE]) as Record<string, { raw: string }>)[key].raw).toBe(corrupt);
  });

  it('对照：键完好时导出原样带出，不写隔离区', async () => {
    const specs = JSON.stringify({ 直径: { lsl: 1, tgt: 2, usl: 3 } });
    localStorage.setItem('qp-specs-v1', specs);
    localStorage.setItem('qp-copy-sequences-v1', JSON.stringify({ 数据集: 2 }));
    const project = await boot();
    const file = JSON.parse(await project.buildProjectJsonFull('t')) as { stores: Record<string, string> };
    expect(file.stores['qp-specs-v1']).toBe(specs);
    expect(file.stores['qp-copy-sequences-v1']).toBe(JSON.stringify({ 数据集: 2 }));
    expect(localStorage.getItem(QUARANTINE)).toBeNull();
  });
});
