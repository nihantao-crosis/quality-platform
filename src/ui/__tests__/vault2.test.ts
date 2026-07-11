/**
 * 大数据集兜底(阶段2)— localStorage 配额超限时:
 * 桌面端活动数据集即时归档 SQLite + 恢复标记 + 启动自动恢复;最近列表瘦身。
 * 通过 mock Storage.setItem 模拟配额,假 datasetDb 代替 SQLite。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useData, hydrateActiveFromVault } from '../../store/dataStore';
import { platform, type DatasetDb } from '../../platform/adapter';

const LS_DATASET = 'qp-dataset-v1';
const LS_RECENTS = 'qp-recents-v1';
const LS_ACTIVE_REF = 'qp-active-ref-v1';
/** 超过该字节数的 qp-dataset/qp-recents 写入视为「配额超限」 */
const FAKE_QUOTA = 2000;

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

/** 行数足以让 JSON 超过 FAKE_QUOTA 的"大"数据集 */
const bigRows = () => Array.from({ length: 120 }, (_, i) => [25 + i * 0.001, 24.9 + i * 0.001]);

let fake: ReturnType<typeof fakeDb>;
let origSetItem: typeof Storage.prototype.setItem;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  fake = fakeDb();
  platform.datasetDb = fake.db;
  origSetItem = Storage.prototype.setItem;
  // 模拟配额:数据集/最近列表键超过 FAKE_QUOTA 字节即抛 QuotaExceededError
  Storage.prototype.setItem = function (key: string, value: string) {
    if ((key === LS_DATASET || key === LS_RECENTS) && value.length > FAKE_QUOTA) {
      throw new DOMException('quota', 'QuotaExceededError');
    }
    return origSetItem.call(this, key, value);
  };
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
});

afterEach(() => {
  Storage.prototype.setItem = origSetItem;
  platform.datasetDb = null;
  vi.useRealTimers();
});

describe('配额超限兜底(桌面端)', () => {
  it('大数据集导入:LS 存不下 → 即时入库 + 恢复标记;内存模型正常', async () => {
    useData.getState().importMatrix('大产线.csv', ['a', 'b'], bigRows());
    expect(useData.getState().model.name).toBe('大产线.csv'); // 内存可用
    expect(localStorage.getItem(LS_DATASET)).toBeNull();      // LS 没存下
    expect(localStorage.getItem(LS_ACTIVE_REF)).toBe('大产线.csv'); // 标记就位
    await vi.advanceTimersByTimeAsync(10); // persistActive 即时入库(不等防抖)
    expect(fake.store.has('大产线.csv')).toBe(true);
  });

  it('重启后 hydrateActiveFromVault 自动恢复活动数据集', async () => {
    useData.getState().importMatrix('大产线.csv', ['a', 'b'], bigRows());
    await vi.advanceTimersByTimeAsync(10);
    // 模拟重启:回到演示集(但保留 LS 标记与库)
    const ref = localStorage.getItem(LS_ACTIVE_REF);
    useData.getState().resetDemo(); // resetDemo 会清标记——先存再放回,模拟真实重启读到的状态
    localStorage.setItem(LS_ACTIVE_REF, ref!);
    expect(useData.getState().model.name).toBe('质检数据.mtw');
    hydrateActiveFromVault();
    await vi.advanceTimersByTimeAsync(10);
    expect(useData.getState().model.name).toBe('大产线.csv');
    expect(useData.getState().model.k).toBe(120);
  });

  it('小数据集正常入 LS 并清除标记', () => {
    localStorage.setItem(LS_ACTIVE_REF, '残留标记');
    useData.getState().importMatrix('小.csv', ['x'], [[1], [2], [3]]);
    expect(localStorage.getItem(LS_DATASET)).not.toBeNull();
    expect(localStorage.getItem(LS_ACTIVE_REF)).toBeNull();
  });

  it('最近列表超限 → 瘦身条目(去 data)持久化;loadRecent 经库回落', async () => {
    useData.getState().importMatrix('大产线.csv', ['a', 'b'], bigRows());
    await vi.advanceTimersByTimeAsync(10);
    const persisted = JSON.parse(localStorage.getItem(LS_RECENTS) ?? '[]');
    expect(persisted.length).toBe(1);
    expect(persisted[0].name).toBe('大产线.csv');
    expect(persisted[0].data).toBeUndefined(); // 瘦身
    // 模拟重启后从瘦身条目加载
    useData.setState({ recents: persisted });
    useData.getState().resetDemo();
    useData.getState().loadRecent('大产线.csv');
    await vi.advanceTimersByTimeAsync(10);
    expect(useData.getState().model.name).toBe('大产线.csv');
  });

  it('Web 端(无库)超限仅提示,不写标记', async () => {
    platform.datasetDb = null;
    useData.getState().importMatrix('大产线.csv', ['a', 'b'], bigRows());
    await vi.advanceTimersByTimeAsync(10);
    expect(localStorage.getItem(LS_ACTIVE_REF)).toBeNull();
    expect(useData.getState().model.name).toBe('大产线.csv'); // 内存仍可用
  });
});
