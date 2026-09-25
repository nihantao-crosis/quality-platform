/**
 * fix2609d · G4c-datastore (5) M2 跨窗口写乒乓回归：
 * 窗口 W1 的活动表写盘失败(未落盘标志常驻)，窗口 W2 随后写入同名但内容不同的数据集。
 * 修复前 W1 的 LS_RECENTS 监听器以内存活动表为准并立即回写，W2 按其 LS_DATASET 协调后再写回，
 * 两窗口交替写 LS_RECENTS 永不停止。修复后：一次外部写后本窗口最多回写一次，随后收敛。
 * 两个窗口 = 两个独立加载的真实 dataStore 模块实例，共享同一 localStorage；
 * 另一窗口的写入用真实 StorageEvent 派发(各窗口 crossTab 按「本窗口最后一次写入」忽略自己的回投)。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeSetItem = Storage.prototype.setItem;
const RECENTS = 'qp-recents-v1';
let failDataset = false;
let recentsWrites = 0;
const pendingEvents: string[] = [];

async function openWindow() {
  vi.resetModules();
  const adapter = await import('../../platform/adapter');
  adapter.platform.datasetDb = null;
  return import('../../store/dataStore');
}

/** 逐个投递排队的 storage 事件(两个窗口都收到，写入者自己按 localWrites 忽略)；返回投递次数。 */
function pump(limit = 60): number {
  let delivered = 0;
  while (pendingEvents.length > 0 && delivered < limit) {
    const newValue = pendingEvents.shift()!;
    window.dispatchEvent(new StorageEvent('storage', { key: RECENTS, newValue, storageArea: localStorage }));
    delivered++;
  }
  return delivered;
}

beforeEach(() => {
  localStorage.clear();
  failDataset = false;
  recentsWrites = 0;
  pendingEvents.length = 0;
  Storage.prototype.setItem = function tracked(key: string, value: string) {
    if (key === 'qp-dataset-v1' && failDataset) throw new DOMException('quota', 'QuotaExceededError');
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

describe('M2 跨窗口 LS_RECENTS 写乒乓', () => {
  it('未落盘窗口收到同名不同内容的外部列表：只在内存保住活动表，不回写，两窗口收敛', async () => {
    const w1 = await openWindow();
    const w2 = await openWindow();

    failDataset = true;
    w1.useData.getState().importMatrix('X.csv', ['x'], [[1], [2]]);
    expect(w1.useData.getState().activeUnpersisted).toBe(true);
    failDataset = false;
    pump();

    w2.useData.getState().importMatrix('X.csv', ['x'], [[9], [9], [9]]);
    const before = recentsWrites;
    const delivered = pump();

    expect(pendingEvents).toHaveLength(0);
    expect(delivered).toBeLessThanOrEqual(3);
    expect(recentsWrites - before).toBeLessThanOrEqual(2);
    // W1 内存仍以自己未落盘的活动表为准(不被外部列表回退)
    expect(w1.useData.getState().recents.find((entry) => entry.name === 'X.csv')?.data?.rows).toEqual([[1], [2]]);
    // localStorage 的最终内容确定：W2 已落盘的版本
    const stored = JSON.parse(localStorage.getItem(RECENTS) ?? '[]') as Array<{ name: string; data?: { rows: number[][] } }>;
    expect(stored.find((entry) => entry.name === 'X.csv')?.data?.rows).toEqual([[9], [9], [9]]);
  });
});
