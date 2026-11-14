/**
 * fix2609i · G15-datastore 回归(2b+1d 对抗复审 1d-divergence 残余 P2)：
 * Web 端最近列表重试写盘成功、活动槽重试仍写不下时(全局配额下腾出空间 Δ≤S<2Δ 即可触发，无需按键注错)，
 * LS_DATASET 里残留的同名旧版曾被启动协调与另一窗口「标志为假」协调分支当作权威：切换到同样写不下的大表后，
 * 本窗口编辑被对端回退、刷新后回到旧版。修复：retryUnpersistedActive 失败且 LS_RECENTS 已含活动表精确版本时
 * 删除过时的同名活动槽。
 *
 * 存储满用「全局字节配额」模拟：改写 Storage.prototype.setItem，按全部键的总字符数判断，不按键注错。
 * 两个窗口是 vi.resetModules 各自加载的真实 dataStore 实例，共享 jsdom localStorage；LS_RECENTS 每次写入
 * 排队后用真实 StorageEvent 投递。「刷新」= 再加载一个新实例，只读 localStorage。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const RECENTS = 'qp-recents-v1';
const DATASET = 'qp-dataset-v1';
/** 编辑值：String(v) 18 个字符，比原值 1..7 多 17 个字符。 */
const EDIT = 1.2345678901234567;
const X_ROWS = [[1], [2], [3], [4], [5], [6], [7]];
const EDITED_X = X_ROWS.map(() => [EDIT]);
const BIG_Y = Array.from({ length: 200 }, (_, i) => [5.123456 + i]);

type DataStoreModule = typeof import('../../store/dataStore');

const nativeSetItem = Storage.prototype.setItem;
const pendingEvents: string[] = [];
let quota: number | null = null;
let failDatasetKey = false;

function usedExcept(storage: Storage, skip: string): number {
  let total = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!;
    if (key === skip) continue;
    total += key.length + (storage.getItem(key) ?? '').length;
  }
  return total;
}

function usedBytes(): number {
  return usedExcept(localStorage, '');
}

async function openWindow(): Promise<DataStoreModule> {
  vi.resetModules();
  const adapter = await import('../../platform/adapter');
  adapter.platform.datasetDb = null;
  return import('../../store/dataStore');
}

function pump(limit = 60): number {
  let delivered = 0;
  while (pendingEvents.length > 0 && delivered < limit) {
    const newValue = pendingEvents.shift()!;
    window.dispatchEvent(new StorageEvent('storage', { key: RECENTS, newValue, storageArea: localStorage }));
    delivered++;
  }
  return delivered;
}

function storedX(key: string): number[][] | undefined {
  const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
  if (Array.isArray(parsed)) {
    return (parsed as Array<{ name: string; data?: { rows: number[][] } }>).find((entry) => entry.name === 'X.csv')?.data?.rows;
  }
  const single = parsed as { name?: string; rows?: number[][] } | null;
  return single?.name === 'X.csv' ? single.rows : undefined;
}

function recentX(w: DataStoreModule): number[][] | undefined {
  return w.useData.getState().recents.find((entry) => entry.name === 'X.csv')?.data?.rows;
}

/** 把 X 的每一行都改成长数值：活动槽与最近列表各增长 Δ=7×17=119 个字符。 */
async function editX(w: DataStoreModule) {
  vi.useFakeTimers();
  X_ROWS.forEach((_, row) => w.useData.getState().updateCell(row, 0, EDIT));
  await vi.runAllTimersAsync();
  vi.useRealTimers();
}

const DELTA = 7 * 17;

beforeEach(() => {
  localStorage.clear();
  pendingEvents.length = 0;
  quota = null;
  failDatasetKey = false;
  Storage.prototype.setItem = function quotaLimited(this: Storage, key: string, value: string) {
    if (key === DATASET && failDatasetKey) throw new DOMException('quota', 'QuotaExceededError');
    if (quota !== null && usedExcept(this, key) + key.length + value.length > quota) {
      throw new DOMException('quota', 'QuotaExceededError');
    }
    nativeSetItem.call(this, key, value);
    if (key === RECENTS) pendingEvents.push(value);
  };
});

afterEach(() => {
  Storage.prototype.setItem = nativeSetItem;
  vi.useRealTimers();
  localStorage.clear();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function seed(): Promise<DataStoreModule> {
  const w1 = await openWindow();
  w1.useData.getState().importMatrix('Z.csv', ['x'], [[8], [9]]);
  w1.useData.getState().importMatrix('Y.csv', ['x'], BIG_Y);
  w1.useData.getState().importMatrix('X.csv', ['x'], X_ROWS);
  expect(w1.useData.getState().model.name).toBe('X.csv');
  return w1;
}

describe('fix2609i G15 · 活动槽重试失败后过时的同名 LS_DATASET 不再当权威', () => {
  it('D2 两窗口：编辑写不下 → × 移除 Z(Δ≤S<2Δ) → 切到写不下的大表 Y → 编辑不被对端回退，刷新后仍是最新版', async () => {
    const w1 = await seed();
    pendingEvents.length = 0;
    const w2 = await openWindow();
    expect(w2.useData.getState().model.name).toBe('X.csv');

    // 全局配额恰好卡在当前用量：编辑后活动槽与最近列表都写不下
    quota = usedBytes();
    await editX(w1);
    expect(w1.useData.getState().recentsUnpersisted).toBe(true);
    expect(storedX(DATASET)).toEqual(X_ROWS);

    // × 移除 Z 腾出的空间 S 满足 Δ ≤ S < 2Δ：最近列表写得下，活动槽重试仍写不下
    const zEntry = JSON.stringify(w1.useData.getState().recents.find((entry) => entry.name === 'Z.csv')).length + 1;
    expect(zEntry).toBeGreaterThanOrEqual(DELTA);
    expect(zEntry).toBeLessThan(2 * DELTA);
    w1.useData.getState().removeRecent('Z.csv');
    expect(w1.useData.getState().recentsUnpersisted).toBe(false);
    expect(storedX(RECENTS)).toEqual(EDITED_X);
    // 过时的同名活动槽已移除，并明确提示最新版在最近列表
    expect(localStorage.getItem(DATASET)).toBeNull();
    pump();
    expect(pendingEvents).toHaveLength(0);
    expect(storedX(RECENTS)).toEqual(EDITED_X);
    expect(recentX(w2)).toEqual(EDITED_X);

    // 切到同样写不下的大表 Y
    expect(await w1.useData.getState().loadRecent('Y.csv')).toBe(true);
    expect(w1.useData.getState().model.name).toBe('Y.csv');
    expect(localStorage.getItem(DATASET)).toBeNull();
    pump();
    expect(pendingEvents).toHaveLength(0);
    expect(recentX(w1)).toEqual(EDITED_X);
    expect(recentX(w2)).toEqual(EDITED_X);
    expect(storedX(RECENTS)).toEqual(EDITED_X);

    // 刷新
    const w3 = await openWindow();
    expect(recentX(w3)).toEqual(EDITED_X);
  });

  it('D2s 单窗口：同一流程后刷新，启动协调不再用过时活动槽覆盖最近列表里的最新版', async () => {
    const w1 = await seed();
    quota = usedBytes();
    await editX(w1);
    w1.useData.getState().removeRecent('Z.csv');
    expect(localStorage.getItem(DATASET)).toBeNull();
    expect(await w1.useData.getState().loadRecent('Y.csv')).toBe(true);
    const w3 = await openWindow();
    expect(recentX(w3)).toEqual(EDITED_X);
    // 重新打开 X 得到的是最新版
    expect(await w3.useData.getState().loadRecent('X.csv')).toBe(true);
    expect(w3.useData.getState().model.subs.map((subgroup) => subgroup.vals)).toEqual(EDITED_X);
  });

  it('闸门重试路径：别处腾出 Δ≤S<2Δ 后直接切换，最近列表重试成功、活动槽仍写不下 → 过时活动槽移除，刷新后仍是最新版', async () => {
    const w1 = await seed();
    // 其他页面/应用占用的空间，稍后被释放 S=150(Δ=119)
    nativeSetItem.call(localStorage, 'other-app', 'o'.repeat(150 - 'other-app'.length));
    quota = usedBytes();
    await editX(w1);
    expect(w1.useData.getState().recentsUnpersisted).toBe(true);
    expect(w1.datasetReplacementBlockReason()).not.toBeNull();

    localStorage.removeItem('other-app');
    expect(await w1.useData.getState().loadRecent('Y.csv')).toBe(true);
    expect(localStorage.getItem(DATASET)).toBeNull();
    expect(storedX(RECENTS)).toEqual(EDITED_X);
    const w3 = await openWindow();
    expect(recentX(w3)).toEqual(EDITED_X);
  });

  it('对照：× 移除的正是活动表本身时，磁盘最近列表不含活动表，LS_DATASET 旧版是唯一落盘副本，不得删除', async () => {
    const w1 = await seed();
    failDatasetKey = true;
    await editX(w1);
    w1.useData.getState().removeRecent('X.csv');
    expect(storedX(RECENTS)).toBeUndefined();
    expect(storedX(DATASET)).toEqual(X_ROWS);
  });

  it('对照：活动槽重试成功时照常写入最新版，不删除', async () => {
    const w1 = await seed();
    quota = usedBytes();
    await editX(w1);
    // 腾出足够空间(S≥2Δ)：× 移除大表 Y
    w1.useData.getState().removeRecent('Y.csv');
    expect(storedX(DATASET)).toEqual(EDITED_X);
    expect(storedX(RECENTS)).toEqual(EDITED_X);
    expect(w1.useData.getState().activeUnpersisted).toBe(false);
  });
});
