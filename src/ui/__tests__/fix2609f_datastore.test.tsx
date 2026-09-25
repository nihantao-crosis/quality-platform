/**
 * fix2609f · G4d-datastore 回归(第 1c 批 G4c 对抗复审收口)：
 * (1) Web 挤出确认布防：无需挤出即通过的新建类写入、× 移除、库删除收口都使旧布防作废；确认键含布防时的
 *     最近列表名称序列，列表一变即作废。活动表不在最近列表时按原因出文案，且任意名称的新建类写入都须确认。
 * (2) 库删除按内容核对：最近列表里内容不同的同名数据集保留(可按只插入入库)；light 模式保全义务随删除收口。
 * (3) 跨窗口：本窗口活动表未落盘、另一窗口回退 LS_RECENTS 后，闸门仍拦截并在切换时重试写盘(含 LS_DATASET)，
 *     切换数据集后本窗口的编辑仍在持久化位置，写次数有界。
 * (4) 编号候选名同样走 pristine 判定：源表编辑后连续两次换条件派生，第二次替换「(2)」而不是生成「(3)」。
 * 全部调用真实生产函数/真实组件(useData、Worksheet 粘贴、Modals、Doe、两个独立 dataStore 模块实例)。
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb } from '../../platform/adapter';
import { useApp } from '../../store/appStore';
import {
  DatasetEvictionError,
  awaitDatasetArchived,
  cancelPendingDatasetWork,
  completeVaultDatasetRemoval,
  prepareVaultDatasetRemoval,
  rememberSpecFor,
  settlePendingDatasetWrites,
  useData,
} from '../../store/dataStore';
import { Doe } from '../pages/Doe';
import { Worksheet } from '../pages/Worksheet';
import { Modals } from '../shell/Modals';
import { chartTokens } from '../tokens';

const RECENTS = 'qp-recents-v1';
const DATASET = 'qp-dataset-v1';

function recentNames(): string[] {
  return useData.getState().recents.map((entry) => entry.name);
}

async function editCell(row: number, col: number, value: number) {
  vi.useFakeTimers();
  useData.getState().updateCell(row, col, value);
  await vi.runAllTimersAsync();
  vi.useRealTimers();
}

function paste(text: string) {
  fireEvent.paste(screen.getByRole('grid'), { clipboardData: { getData: () => text } });
}

function memoryDb(initial: Array<[string, string]> = []) {
  const store = new Map(initial);
  const db: DatasetDb = {
    async put(name, json) { store.set(name, json); },
    async insert(name, json) { if (store.has(name)) return false; store.set(name, json); return true; },
    async get(name) { return store.get(name) ?? null; },
    async list() { return [...store.keys()].map((name) => ({ name, saved_at: '2026-09-26T00:00:00Z', bytes: 10 })); },
    async remove(name) { return store.delete(name); },
    async clear(opId) { const removed = store.size; store.clear(); return { opId, committed: true, removed }; },
    async clearStatus() { return null; },
    async stats() { return { count: store.size, total_bytes: 0, path: ':memory:' }; },
  };
  return { db, store };
}

function seedFive() {
  for (let i = 1; i <= 5; i++) useData.getState().importMatrix(`D${i}.csv`, ['x'], [[i], [i + 1]]);
  expect(recentNames()).toEqual(['D5.csv', 'D4.csv', 'D3.csv', 'D2.csv', 'D1.csv']);
}

function importRename(name: string, rows: number[][]) {
  return useData.getState().importMatrix(name, ['x'], rows, [], [], { onNameConflict: 'rename' });
}

function evictionError(run: () => unknown): DatasetEvictionError | null {
  try { run(); } catch (error) { if (error instanceof DatasetEvictionError) return error; throw error; }
  return null;
}

beforeEach(() => {
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({ page: 'worksheet', modal: null, busyOverlay: null, toast: null, selSub: null, openMenu: null, varOpen: false });
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.restoreAllMocks();
});

describe('(1) Web 挤出确认布防作废', () => {
  it('场景 B：DOE 被拒 → × 移除另一条 → 生成成功 → 60 秒内再生成，必须再次被拒，D1 不被移出', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T10:00:00'));
    try {
      seedFive();
      useApp.setState({ page: 'doe', doeTab: 'create' });
      render(<Doe T={chartTokens('经典', true)} />);
      const button = () => screen.getByRole('button', { name: '生成设计表 → 工作表' });
      const generate = () => {
        act(() => { useApp.setState({ page: 'doe', doeTab: 'create', toast: null }); });
        fireEvent.click(button());
      };
      generate();
      expect(useApp.getState().toast).toContain('最近列表已满');
      expect(recentNames()).toContain('D1.csv');
      // 用户按提示走另一条路：移除不需要的 D3
      useData.getState().removeRecent('D3.csv');
      vi.setSystemTime(new Date('2026-09-26T10:00:05'));
      generate();
      expect(useData.getState().model.name).toMatch(/^DOE设计_100005_/);
      expect(recentNames()).toContain('D1.csv');
      // 20 秒后再生成：列表又满，这次必须重新拒绝，而不是消费旧布防把 D1 永久挤出
      vi.setSystemTime(new Date('2026-09-26T10:00:25'));
      generate();
      expect(useData.getState().model.name).toMatch(/^DOE设计_100005_/);
      expect(recentNames()).toContain('D1.csv');
      expect(useApp.getState().toast).toContain('最近列表已满');
      // 这一次拒绝重新布防，按提示再次执行才确认
      vi.setSystemTime(new Date('2026-09-26T10:00:30'));
      generate();
      expect(useData.getState().model.name).toMatch(/^DOE设计_100030_/);
      expect(recentNames()).not.toContain('D1.csv');
    } finally {
      vi.useRealTimers();
    }
  });

  it('场景 B2：粘贴被拒 → × 移除另一条 → 粘贴成功 → 再粘贴，必须再次被拒', () => {
    seedFive();
    render(<Worksheet />);
    paste('值\n10\n20');
    expect(useData.getState().model.name).toBe('D5.csv');
    expect(useApp.getState().toast).toContain('最近列表已满');
    useData.getState().removeRecent('D3.csv');
    paste('值\n11\n21');
    expect(useData.getState().model.name).toBe('剪贴板数据');
    paste('值\n12\n22');
    expect(useData.getState().model.name).toBe('剪贴板数据');
    expect(recentNames()).toContain('D1.csv');
    expect(useApp.getState().toast).toContain('最近列表已满');
  });

  it('布防后最近列表顺序变化(编辑使另一表置顶)即作废，即使将被移出的仍是同一个', async () => {
    seedFive();
    expect(evictionError(() => importRename('N.csv', [[1], [2]]))?.evicted).toEqual(['D1.csv']);
    expect(await useData.getState().loadRecent('D3.csv')).toBe(true);
    await editCell(0, 0, 33.3);
    expect(recentNames()).toEqual(['D3.csv', 'D5.csv', 'D4.csv', 'D2.csv', 'D1.csv']);
    expect(evictionError(() => importRename('N.csv', [[1], [2]]))?.evicted).toEqual(['D1.csv']);
    expect(recentNames()).toContain('D1.csv');
  });

  it('只因活动表不在最近列表而拦截时，文案说明当前表不在最近列表，不说「最近列表已满」', async () => {
    importRename('G.csv', [[1], [2]]);
    await editCell(0, 0, 55.5);
    useData.getState().removeRecent('G.csv');
    const error = evictionError(() => importRename('G.csv', [[7], [8]]));
    expect(error?.evicted).toEqual(['G.csv']);
    expect(error?.message).not.toContain('最近列表已满');
    expect(error?.message).toContain('当前表「G.csv」已不在最近列表');
    expect(error?.message).toContain('60 秒内再次执行同一操作');
  });

  it('活动表被 × 移出后，用其他名称的新建类写入(导入 H.csv)同样须确认，不静默替换', async () => {
    importRename('G.csv', [[1], [2]]);
    await editCell(0, 0, 55.5);
    useData.getState().removeRecent('G.csv');
    const error = evictionError(() => importRename('H.csv', [[7], [8]]));
    expect(error?.evicted).toEqual(['G.csv']);
    expect(useData.getState().model.name).toBe('G.csv');
    expect(useData.getState().model.subs[0].vals).toEqual([55.5]);
    // 确认后才替换
    expect(importRename('H.csv', [[7], [8]]).name).toBe('H.csv');
    expect(useData.getState().model.name).toBe('H.csv');
  });

  it('活动表仍在最近列表时，其他名称的新建类写入不受活动表拦截影响', () => {
    importRename('G.csv', [[1], [2]]);
    expect(importRename('H.csv', [[7], [8]]).name).toBe('H.csv');
  });
});

describe('(2) 库删除按内容核对', () => {
  it('桌面：最近列表里的 X 从未入库、库中同名不同内容，删除库记录后最近条目保留且可入库', async () => {
    // Web 导出件 / 旧版项目导入桌面：最近列表中的 X(B) 从未入库
    useData.getState().importMatrix('X.csv', ['x'], [[222], [2]]);
    useData.getState().importMatrix('Y.csv', ['x'], [[5], [6]]);
    const vaultA = JSON.stringify({ name: 'X.csv', colNames: ['x'], rows: [[111], [1]], textCols: [], pendingCells: [], savedAt: '2026-01-01T00:00:00.000Z' });
    const { db, store } = memoryDb([['X.csv', vaultA]]);
    platform.datasetDb = db;
    useApp.setState({ modal: 'vault' });
    render(<Modals />);
    const row = await screen.findByText('X.csv');
    const del = () => [...row.parentElement!.parentElement!.querySelectorAll('button')]
      .find((b) => /删除/.test(b.textContent ?? ''))!;
    fireEvent.click(del());
    fireEvent.click(del());
    await waitFor(() => expect(useApp.getState().toast).toContain('已从数据集库删除 X.csv'));
    expect(useApp.getState().toast).toContain('最近列表中另有内容不同的同名数据集「X.csv」，未删除');
    expect(store.has('X.csv')).toBe(false);
    expect(recentNames()).toContain('X.csv');
    expect(useData.getState().recents.find((entry) => entry.name === 'X.csv')?.data?.rows).toEqual([[222], [2]]);
    // 之后 × 按只插入补存入库：这是保全，不是复活
    useData.getState().removeRecent('X.csv');
    await settlePendingDatasetWrites();
    expect(JSON.parse(store.get('X.csv') ?? 'null')?.rows).toEqual([[222], [2]]);
  });

  it('桌面：light 模式下 X 的 put 失败，删除库中 X(同内容)后导出前的归档等待不再把 X 写回库', async () => {
    const { db, store } = memoryDb();
    platform.datasetDb = db;
    useData.getState().importMatrix('X.csv', ['x'], [[1], [2]]);
    useData.getState().importMatrix('Y.csv', ['x'], [[3], [4]]);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settlePendingDatasetWrites();
    expect(store.has('X.csv')).toBe(true);
    let failX = true;
    const put = db.put.bind(db);
    db.put = async (name, json) => {
      if (name === 'X.csv' && failX) throw new Error('disk busy');
      return put(name, json);
    };
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(this: Storage, key: string, value: string) {
      if (key === RECENTS && value.includes('"rows"')) throw new DOMException('quota', 'QuotaExceededError');
      nativeSetItem.call(this, key, value);
    });
    useData.getState().importMatrix('Z.csv', ['x'], [[5], [6]]);
    await settlePendingDatasetWrites();
    failX = false;
    await prepareVaultDatasetRemoval('X.csv');
    const removedJson = await db.get('X.csv');
    expect(await db.remove('X.csv')).toBe(true);
    completeVaultDatasetRemoval('X.csv', removedJson);
    expect(recentNames()).not.toContain('X.csv');
    await awaitDatasetArchived('Z.csv');
    await settlePendingDatasetWrites();
    expect(store.has('X.csv')).toBe(false);
  });
});

describe('(3) 跨窗口未落盘分支不静默分叉', () => {
  const pendingEvents: string[] = [];
  let failDataset = false;
  let failRecents = false;
  let recentsWrites = 0;
  const nativeSetItem = Storage.prototype.setItem;

  async function openWindow() {
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

  beforeEach(() => {
    pendingEvents.length = 0;
    failDataset = false;
    failRecents = false;
    recentsWrites = 0;
    Storage.prototype.setItem = function tracked(this: Storage, key: string, value: string) {
      if (key === DATASET && failDataset) throw new DOMException('quota', 'QuotaExceededError');
      if (key === RECENTS && failRecents) throw new DOMException('quota', 'QuotaExceededError');
      nativeSetItem.call(this, key, value);
      if (key === RECENTS) {
        recentsWrites++;
        pendingEvents.push(value);
      }
    };
  });

  afterEach(() => {
    Storage.prototype.setItem = nativeSetItem;
    localStorage.clear();
    vi.resetModules();
  });

  it('本窗口编辑未落盘 → × 解锁 → 另一窗口回退 LS_RECENTS → 切换数据集后编辑仍可从持久化位置恢复', async () => {
    const w1 = await openWindow();
    w1.useData.getState().importMatrix('Z.csv', ['x'], [[8], [9]]);
    w1.useData.getState().importMatrix('Y.csv', ['x'], [[5], [6]]);
    w1.useData.getState().importMatrix('X.csv', ['x'], [[1], [2]]);
    pendingEvents.length = 0;
    const w2 = await openWindow();
    expect(w2.useData.getState().model.name).toBe('X.csv');

    // W1 编辑时配额已满：活动槽与最近列表都写不下
    failDataset = true;
    failRecents = true;
    vi.useFakeTimers();
    w1.useData.getState().updateCell(0, 0, 7777);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(w1.useData.getState().recentsUnpersisted).toBe(true);

    // 用户按闸门文案点 × 移除 Z 腾出空间(最近列表写得下了)
    failRecents = false;
    failDataset = false;
    w1.useData.getState().removeRecent('Z.csv');
    const before = recentsWrites;
    pump();
    expect(pendingEvents).toHaveLength(0);
    expect(recentsWrites - before).toBeLessThanOrEqual(2);

    expect(await w1.useData.getState().loadRecent('Y.csv')).toBe(true);
    pump();
    expect(pendingEvents).toHaveLength(0);
    // 刷新：持久化位置里仍有 W1 的编辑
    const recovered = storedX(RECENTS) ?? storedX(DATASET);
    expect(recovered?.[0]).toEqual([7777]);
    const w3 = await openWindow();
    expect(w3.useData.getState().recents.find((entry) => entry.name === 'X.csv')?.data?.rows[0]).toEqual([7777]);
  });

  it('× 后活动槽仍写不下：过时的同名活动槽被移除(fix2609i G15)，另一窗口不再按它回退，切换后编辑仍在，写次数有界', async () => {
    const w1 = await openWindow();
    w1.useData.getState().importMatrix('Z.csv', ['x'], [[8], [9]]);
    w1.useData.getState().importMatrix('Y.csv', ['x'], [[5], [6]]);
    w1.useData.getState().importMatrix('X.csv', ['x'], [[1], [2]]);
    pendingEvents.length = 0;
    const w2 = await openWindow();
    expect(w2.useData.getState().model.name).toBe('X.csv');

    failDataset = true;
    failRecents = true;
    vi.useFakeTimers();
    w1.useData.getState().updateCell(0, 0, 7777);
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    failRecents = false;
    w1.useData.getState().removeRecent('Z.csv');
    expect(w1.useData.getState().recentsUnpersisted).toBe(false);
    // 活动槽重试仍失败：LS_RECENTS 已含 7777，共享 LS_DATASET 里的同名旧版不能再当权威
    expect(localStorage.getItem(DATASET)).toBeNull();
    const before = recentsWrites;
    pump();
    expect(pendingEvents).toHaveLength(0);
    expect(recentsWrites - before).toBeLessThanOrEqual(2);
    // W2 找不到同名活动槽，只水合最新列表，不回退
    expect(storedX(RECENTS)?.[0]).toEqual([7777]);
    expect(w2.useData.getState().recents.find((entry) => entry.name === 'X.csv')?.data?.rows[0]).toEqual([7777]);
    expect(w1.useData.getState().recentsUnpersisted).toBe(false);
    expect(w1.datasetReplacementBlockReason()).toBeNull();

    const beforeSwitch = recentsWrites;
    expect(await w1.useData.getState().loadRecent('Y.csv')).toBe(true);
    // 闸门未拦截，无需重试写盘
    expect(recentsWrites - beforeSwitch).toBeLessThanOrEqual(1);
    pump();
    expect(pendingEvents).toHaveLength(0);
    expect(recentsWrites - beforeSwitch).toBeLessThanOrEqual(2);
    expect(storedX(RECENTS)?.[0]).toEqual([7777]);
    const w3 = await openWindow();
    expect(w3.useData.getState().recents.find((entry) => entry.name === 'X.csv')?.data?.rows[0]).toEqual([7777]);
  });
});

describe('(4) 编号候选名走 pristine 判定', () => {
  it('源表编辑后连续两次换条件派生：第二次替换「A (子集) (2)」而不是生成「(3)」，规格保留', async () => {
    useData.getState().importMatrix('A.csv', ['x', 'y'], [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60]]);
    expect(useData.getState().subsetByCondition('C1 >= 4')).toMatchObject({ ok: true, name: 'A (子集)' });
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    await editCell(5, 1, 66);
    expect(useData.getState().subsetByCondition('C1 >= 4')).toMatchObject({ ok: true, name: 'A (子集) (2)' });
    rememberSpecFor('A (子集) (2)', { lsl: 1, tgt: 2, usl: 3 });
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    const again = useData.getState().subsetByCondition('C1 <= 3');
    expect(again).toMatchObject({ ok: true, name: 'A (子集) (2)' });
    expect(again.ok && again.outcome.replacedPristine).toBe(true);
    expect(recentNames()).toEqual(['A (子集) (2)', 'A.csv', 'A (子集)']);
    expect(JSON.parse(localStorage.getItem('qp-specs-v1') ?? '{}')['A (子集) (2)']).toEqual({ lsl: 1, tgt: 2, usl: 3 });
  });
});
