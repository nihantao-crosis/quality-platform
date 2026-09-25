/**
 * v1.43 持久化安全回归：SQLite 同名写顺序 + 回看前副本 durable 闸门。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platform, type DatasetDb } from "../../platform/adapter";
import { buildProjectJsonFull } from "../../platform/project";
import {
  cancelPendingDatasetWork,
  settlePendingDatasetWrites,
  useData,
} from "../../store/dataStore";
import { useAnalyses, type SavedAnalysis } from "../../store/analyses";
import { useApp } from "../../store/appStore";

interface DeferredPut {
  name: string;
  json: string;
  resolve(): void;
  reject(error: Error): void;
}

function controlledDb() {
  const store = new Map<string, string>();
  const puts: DeferredPut[] = [];
  const db: DatasetDb = {
    insert(name, json) {
      return new Promise<boolean>((resolve, reject) => {
        puts.push({
          name, json,
          resolve: () => {
            if (store.has(name)) { resolve(false); return; }
            store.set(name, json);
            resolve(true);
          },
          reject,
        });
      });
    },
    put(name, json) {
      return new Promise<void>((resolve, reject) => {
        puts.push({
          name,
          json,
          resolve: () => {
            store.set(name, json);
            resolve();
          },
          reject,
        });
      });
    },
    async get(name) {
      return store.get(name) ?? null;
    },
    async list() {
      return [...store.entries()].map(([name, json]) => ({
        name,
        saved_at: "t",
        bytes: json.length,
      }));
    },
    async remove(name) {
      return store.delete(name);
    },
    async clear(opId) {
      const removed = store.size;
      store.clear();
      return { opId, committed: true, removed };
    },
    async clearStatus() { return null; },
    async stats() {
      return { count: store.size, total_bytes: 0, path: ":memory:" };
    },
  };
  return { db, puts, store };
}

async function drainPromises() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const nativeSetItem = Storage.prototype.setItem;

function installCopyQuotaFailure() {
  Storage.prototype.setItem = function setItemWithCopyQuota(
    key: string,
    value: string,
  ) {
    // 只让自动副本的活动表/最近表超配额；快照本身恢复时仍可落 localStorage。
    const savingCopy =
      key === "qp-dataset-v1"
        ? String(JSON.parse(value).name).includes("(副本")
        : key === "qp-recents-v1"
          ? String(JSON.parse(value)[0]?.name ?? "").includes("(副本")
          : false;
    if (savingCopy) throw new DOMException("quota", "QuotaExceededError");
    return nativeSetItem.call(this, key, value);
  };
}

function seedRestoreCase(): SavedAnalysis {
  useData.getState().importMatrix("研究.csv", ["x"], [[9], [8], [7]]);
  const analysis: SavedAnalysis = {
    id: "durable-restore",
    kind: "summary",
    title: "历史描述性统计",
    datasetName: "研究.csv",
    metric: "平均值 2",
    status: "已分析",
    statusColor: "#000",
    statusBg: "#fff",
    createdAt: 1,
    snapshot: {
      snapshotVersion: 7,
      activeVar: "x",
      sourceData: {
        name: "研究.csv",
        colNames: ["x"],
        rows: [[1], [2], [3]],
        textCols: [],
      },
    },
  };
  useAnalyses.setState({ saved: [analysis], lastError: null });
  useApp.setState({ page: "dashboard", toast: null });
  return analysis;
}

beforeEach(() => {
  vi.useFakeTimers();
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useAnalyses.setState({ saved: [], lastError: null });
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
});

afterEach(async () => {
  Storage.prototype.setItem = nativeSetItem;
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.useRealTimers();
});

describe("SQLite 同名写入的 latest-wins 顺序", () => {
  it("旧 put 未结束时不发起新 put；旧失败后新版仍落库且不会被失败表重放覆盖", async () => {
    const fake = controlledDb();
    platform.datasetDb = fake.db;

    useData.getState().importMatrix("同名.csv", ["x"], [[1], [2], [3]]);
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.puts).toHaveLength(1);
    expect(JSON.parse(fake.puts[0].json).rows).toEqual([[1], [2], [3]]);

    useData.getState().updateCell(0, 0, 99);
    await vi.advanceTimersByTimeAsync(400);
    // 关键断言：第二次调用连发都没发，因此假 DB 无法以乱序 resolve 覆盖新值。
    expect(fake.puts).toHaveLength(1);

    fake.puts[0].reject(new Error("old put failed late"));
    await drainPromises();
    expect(fake.puts).toHaveLength(2);
    expect(JSON.parse(fake.puts[1].json).rows).toEqual([[99], [2], [3]]);

    fake.puts[1].resolve();
    await settlePendingDatasetWrites();
    expect(JSON.parse(fake.store.get("同名.csv")!).rows).toEqual([
      [99],
      [2],
      [3],
    ]);

    // 旧失败记账必须已被后续新版成功清除；导出 flush 不得第三次重放旧值。
    await buildProjectJsonFull("1.43.0");
    expect(fake.puts).toHaveLength(2);
    expect(JSON.parse(fake.store.get("同名.csv")!).rows).toEqual([
      [99],
      [2],
      [3],
    ]);
  });
});

describe("分析回看的 durable 副本闸门", () => {
  it("SQLite 副本写入未决时 restore 不覆盖，写入失败时 fail-closed 并保留当前编辑", async () => {
    const analysis = seedRestoreCase();
    const fake = controlledDb();
    platform.datasetDb = fake.db;
    installCopyQuotaFailure();

    let settled = false;
    const restore = useAnalyses
      .getState()
      .restore(analysis.id)
      .finally(() => {
        settled = true;
      });
    await drainPromises();
    expect(fake.puts).toHaveLength(1);
    expect(settled).toBe(false);
    expect(useData.getState().model.name).toBe("研究.csv");
    expect(useData.getState().model.subs.map((row) => row.vals[0])).toEqual([
      9, 8, 7,
    ]);

    fake.puts[0].reject(new Error("disk full"));
    await expect(restore).resolves.toBe(false);
    expect(useData.getState().model.name).toBe("研究.csv");
    expect(useData.getState().model.subs.map((row) => row.vals[0])).toEqual([
      9, 8, 7,
    ]);
    expect(useApp.getState().page).toBe("dashboard");
    expect(useApp.getState().toast).toContain("未能写入本机数据库");

    // 失败后源表及后续编辑保持不变；重试仍必须通过只插入 durability 闸门。
    const retry = useAnalyses.getState().restore(analysis.id);
    await drainPromises();
    expect(fake.puts).toHaveLength(2);
    expect(useData.getState().model.subs.map((row) => row.vals[0])).toEqual([
      9, 8, 7,
    ]);
    fake.puts[1].reject(new Error("disk still full"));
    await expect(retry).resolves.toBe(false);
    expect(useData.getState().model.subs.map((row) => row.vals[0])).toEqual([
      9, 8, 7,
    ]);
  });

  it("只在 SQLite 副本真正 resolve 后才允许快照覆盖", async () => {
    const analysis = seedRestoreCase();
    const fake = controlledDb();
    platform.datasetDb = fake.db;
    installCopyQuotaFailure();

    let settled = false;
    const restore = useAnalyses
      .getState()
      .restore(analysis.id)
      .finally(() => {
        settled = true;
      });
    await drainPromises();
    expect(settled).toBe(false);
    expect(useData.getState().model.subs.map((row) => row.vals[0])).toEqual([
      9, 8, 7,
    ]);

    fake.puts[0].resolve();
    await expect(restore).resolves.toBe(true);
    expect(useData.getState().model.name).toBe("研究.csv");
    expect(useData.getState().model.subs.map((row) => row.vals[0])).toEqual([
      1, 2, 3,
    ]);
    expect(useApp.getState().page).toBe("summary");
  });
});
