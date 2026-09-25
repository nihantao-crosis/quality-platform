/**
 * fix2609b · G4b-datastore 回归(第 1 批 G4 对抗复审 M1–M4)：
 * - M1 STORE-04/UI-04/holistic：改名策略不得让最近列表截断静默挤出无关的已编辑数据集(Web 端即永久丢失)；
 *   旧同名数据集未经编辑时仍按名替换；改名/挤出提示按实际位置生成。
 * - M2 STORE-08：闸门自动重试必须写入含活动表精确矩阵的列表；跨窗口水合不得挤掉未落盘的活动表。
 * - M3 STORE-03 残项：clearPareto/resetDemo 删除业务键须清 dirty 载荷，已清空内容不得随 .qproj 复活。
 * - M4：备份指引统一指向「文件 → 保存项目文件…」（Ctrl+S）。
 * 全部调用真实生产函数(useData / Worksheet 粘贴 / buildProjectJsonFull)，只模拟存储配额与另一窗口写入。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb } from '../../platform/adapter';
import { buildProjectJsonFull } from '../../platform/project';
import { useApp } from '../../store/appStore';
import {
  DatasetEvictionError,
  cancelPendingDatasetWork,
  datasetWriteNotes,
  settlePendingDatasetWrites,
  useData,
} from '../../store/dataStore';
import { Worksheet } from '../pages/Worksheet';

const nativeSetItem = Storage.prototype.setItem;

function recentNames(): string[] {
  return useData.getState().recents.map((entry) => entry.name);
}

function persistedRecent(name: string): { rows: number[][] } | undefined {
  const raw = localStorage.getItem('qp-recents-v1');
  if (!raw) return undefined;
  return (JSON.parse(raw) as Array<{ name: string; data?: { rows: number[][] } }>)
    .find((entry) => entry.name === name)?.data;
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
    async list() { return [...store.keys()].map((name) => ({ name, saved_at: '', bytes: 0 })); },
    async remove(name) { return store.delete(name); },
    async clear(opId) { const removed = store.size; store.clear(); return { opId, committed: true, removed }; },
    async clearStatus() { return null; },
    async stats() { return { count: store.size, total_bytes: 0, path: ':memory:' }; },
  };
  return { db, store };
}

/** 供应商A(已编辑) + 3 张表：最近列表 4 项，最旧的是已编辑的供应商A。 */
async function seedFourWithEditedOldest() {
  useData.getState().importMatrix('供应商A来料.csv', ['x'], [[1], [2], [3]]);
  await editCell(0, 0, 77.25);
  for (let i = 1; i <= 3; i++) useData.getState().importMatrix(`表${i}.csv`, ['x'], [[i], [i + 1]]);
  expect(recentNames()).toEqual(['表3.csv', '表2.csv', '表1.csv', '供应商A来料.csv']);
}

beforeEach(() => {
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({ page: 'worksheet', modal: null, busyOverlay: null, toast: null, selSub: null });
});

afterEach(async () => {
  cleanup();
  Storage.prototype.setItem = nativeSetItem;
  vi.useRealTimers();
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.restoreAllMocks();
});

describe('M1 最近列表挤出保全(Web 端无本机库)', () => {
  it('未经编辑的上一份粘贴也不按名替换(剪贴板不可重算，fix2609d)：需改名且会挤出时先拒绝，两份数据都不丢', async () => {
    render(<Worksheet />);
    await seedFourWithEditedOldest();
    paste('值\n10\n20');
    expect(recentNames()).toHaveLength(5);
    paste('值\n1\n2\n3');
    expect(useApp.getState().toast).toContain('最近列表已满（5 个）');
    expect(useData.getState().model.name).toBe('剪贴板数据');
    expect(useData.getState().model.subs.map((s) => s.vals)).toEqual([[10], [20]]);
    expect(recentNames()).toHaveLength(5);
    expect(recentNames()).toContain('供应商A来料.csv');
    expect(persistedRecent('供应商A来料.csv')?.rows[0]).toEqual([77.25]);
  });

  it('已编辑的粘贴数据再粘贴需改名时：先拒绝并如实提示；同一操作再执行才确认移出，且提示不再写死「保留」', async () => {
    render(<Worksheet />);
    await seedFourWithEditedOldest();
    paste('值\n10\n20');
    await editCell(0, 0, 99.5);
    paste('值\n1\n2\n3');
    // 未静默截断：写入被拒，当前表与最旧的已编辑数据集原样保留
    const refusal = useApp.getState().toast ?? '';
    expect(refusal).toContain('最近列表已满（5 个）');
    expect(refusal).toContain('「供应商A来料.csv」');
    expect(refusal).toContain('浏览器端无法恢复');
    expect(refusal).toContain('保存项目文件');
    expect(useData.getState().model.name).toBe('剪贴板数据');
    expect(useData.getState().model.subs[0].vals).toEqual([99.5]);
    expect(persistedRecent('供应商A来料.csv')?.rows[0]).toEqual([77.25]);

    // 用户按提示确认：同一操作再执行一次
    paste('值\n1\n2\n3');
    expect(useData.getState().model.name).toBe('剪贴板数据 (2)');
    const done = useApp.getState().toast ?? '';
    expect(done).toContain('原数据集保留在最近列表');
    expect(done).toContain('「供应商A来料.csv」已移出最近列表，浏览器端无法恢复');
    expect(persistedRecent('剪贴板数据')?.rows[0]).toEqual([99.5]);
  });

  it('派生(随机数据)需改名且会挤出时同样拒绝；allowEviction 显式确认后在结果中返回被移出的名称', async () => {
    useData.getState().importMatrix('E.csv', ['x'], [[1], [2], [3]]);
    await editCell(0, 0, 5);
    for (let i = 1; i <= 3; i++) useData.getState().importMatrix(`D${i}.csv`, ['x'], [[i], [i + 1]]);
    expect(useData.getState().generateRandom(10, 1, 3, 1).name).toBe('随机数据 N(10,1)');
    let error: unknown = null;
    try { useData.getState().generateRandom(10, 1, 3, 1); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(DatasetEvictionError);
    expect((error as DatasetEvictionError).evicted).toEqual(['E.csv']);
    expect(recentNames()).toContain('E.csv');
    expect(persistedRecent('E.csv')?.rows[0]).toEqual([5]);

    const outcome = useData.getState().importMatrix(
      '随机数据 N(10,1)', ['X1'], [[1], [2], [3]], [], [], { onNameConflict: 'rename', allowEviction: true },
    );
    expect(outcome.name).toBe('随机数据 N(10,1) (2)');
    expect(outcome.evicted).toEqual(['E.csv']);
    expect(outcome.conflictLocation).toBe('recents');
    expect(datasetWriteNotes('随机数据 N(10,1)', outcome).join(' ')).toContain('「E.csv」已移出最近列表，浏览器端无法恢复');
  });

  it('子集派生被拒时返回可读错误而非抛出，列表不变', async () => {
    useData.getState().importMatrix('A.csv', ['x', 'y'], [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60]]);
    const first = useData.getState().subsetByCondition('C1 >= 4');
    expect(first).toMatchObject({ ok: true, name: 'A (子集)' });
    await editCell(0, 1, 777);
    for (let i = 1; i <= 3; i++) useData.getState().importMatrix(`D${i}.csv`, ['x'], [[i], [i + 1]]);
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    const before = recentNames();
    expect(before).toEqual(['D3.csv', 'D2.csv', 'D1.csv', 'A (子集)', 'A.csv']);
    const second = useData.getState().subsetByCondition('C1 <= 3');
    expect(second.ok).toBe(false);
    expect(second.ok ? '' : second.error).toContain('最近列表已满');
    expect(second.ok ? '' : second.error).toContain('「A.csv」');
    expect(recentNames()).toEqual(before);
    expect(persistedRecent('A (子集)')?.rows[0]).toEqual([4, 777]);
  });

  it('非新建类写入(新建工作表)挤出时不静默：结果带 evicted 且弹出警告', () => {
    for (let i = 1; i <= 5; i++) useData.getState().importMatrix(`D${i}.csv`, ['x'], [[i], [i + 1]]);
    const outcome = useData.getState().newWorksheet();
    expect(outcome.evicted).toEqual(['D1.csv']);
    expect(useApp.getState().toast).toContain('「D1.csv」已移出最近列表');
    expect(useApp.getState().toast).toContain('无法恢复');
  });

  it('同名文件再导入：内容不同即改名(文件不可重算，未编辑也不按名替换，fix2609d)', async () => {
    const opts = { onNameConflict: 'rename' as const };
    expect(useData.getState().importMatrix('report.csv', ['x'], [[1], [2]], [], [], opts).name).toBe('report.csv');
    expect(useData.getState().importMatrix('report.csv', ['x'], [[3], [4]], [], [], opts).name).toBe('report (2).csv');
    expect(recentNames()).toEqual(['report (2).csv', 'report.csv']);
    expect(persistedRecent('report.csv')?.rows).toEqual([[1], [2]]);
  });

  it('转置/堆叠返回实际名称；改名时提示原数据集实际位置', async () => {
    useData.getState().importMatrix('t.csv', ['a', 'b', 'c'], [[1, 2, 3], [4, 5, 6]]);
    expect(useData.getState().transposeDataset().name).toBe('t.csv (转置)');
    await editCell(0, 0, 99);
    expect(await useData.getState().loadRecent('t.csv')).toBe(true);
    const again = useData.getState().transposeDataset();
    expect(again).toMatchObject({ name: 't.csv (转置) (2)', requested: 't.csv (转置)' });
    expect(datasetWriteNotes(again.requested, again.outcome).join(' ')).toContain('原数据集保留在最近列表');
    useData.getState().importMatrix('s.csv', ['a', 'b'], [[1, 2], [3, 4]]);
    expect(useData.getState().stackColumns().name).toBe('s.csv (堆叠)');
  });
});

describe('M1 桌面端：被挤出条目补入本机库(只插入、不覆盖)', () => {
  it('从未入库的最近条目被挤出后补入本机库，仍可 loadRecent', async () => {
    const { db, store } = memoryDb();
    // 模拟无 vault 的 .qproj 恢复：最近列表带全量数据，但本机库里没有
    useData.setState({ recents: [{ name: '网A', savedAt: 't', data: { name: '网A', colNames: ['x'], rows: [[1], [2], [3]], textCols: [], savedAt: 't' } }] });
    platform.datasetDb = db;
    for (let i = 1; i <= 5; i++) useData.getState().importMatrix(`新表${i}.csv`, ['x'], [[i], [i + 1]]);
    expect(recentNames()).not.toContain('网A');
    await settlePendingDatasetWrites();
    expect(JSON.parse(store.get('网A') ?? 'null')?.rows).toEqual([[1], [2], [3]]);
    expect(await useData.getState().loadRecent('网A')).toBe(true);
    expect(useData.getState().model.subs.map((s) => s.vals)).toEqual([[1], [2], [3]]);
  });

  it('库中已有内容不同的同名记录时绝不覆盖，被挤出的版本另存为「名 (2)」并提示', async () => {
    const old = JSON.stringify({ name: '网A', colNames: ['x'], rows: [[9], [9]], textCols: [], savedAt: 'old' });
    const { db, store } = memoryDb([['网A', old]]);
    useData.setState({ recents: [{ name: '网A', savedAt: 't', data: { name: '网A', colNames: ['x'], rows: [[1], [2], [3]], textCols: [], savedAt: 't' } }] });
    platform.datasetDb = db;
    const toasts: string[] = [];
    const unsubscribe = useApp.subscribe((state) => { if (state.toast) toasts.push(state.toast); });
    for (let i = 1; i <= 5; i++) useData.getState().importMatrix(`新表${i}.csv`, ['x'], [[i], [i + 1]]);
    await settlePendingDatasetWrites();
    unsubscribe();
    expect(store.get('网A')).toBe(old);
    expect(JSON.parse(store.get('网A (2)') ?? 'null')).toMatchObject({ name: '网A (2)', rows: [[1], [2], [3]] });
    expect(toasts.join('\n')).toContain('另存为「网A (2)」');
  });

  it('同名旧子集只在本机库时，改名提示说明「可在数据集库中找回」而非「保留在最近列表」', async () => {
    const { db } = memoryDb();
    platform.datasetDb = db;
    const source = [[1, 10], [2, 20], [3, 30], [6, 60], [7, 70], [8, 80]];
    useData.getState().importMatrix('A.csv', ['x', 'y'], source);
    useData.getState().subsetByCondition('C1 >= 6');
    await editCell(0, 1, 777);
    for (let i = 1; i <= 5; i++) useData.getState().importMatrix(`D${i}.csv`, ['x'], [[i], [i + 1]]);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settlePendingDatasetWrites();
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    const again = useData.getState().subsetByCondition('C1 >= 6');
    expect(again).toMatchObject({ ok: true, name: 'A (子集) (2)' });
    const notes = again.ok ? datasetWriteNotes(again.requested, again.outcome).join(' ') : '';
    expect(notes).toContain('数据集库');
    expect(notes).not.toContain('保留在最近列表');
  });
});

describe('M2 闸门自动重试须含活动表精确矩阵', () => {
  const bigRows = Array.from({ length: 400 }, (_, i) => [i + 0.123456, i * 2 + 0.654321]);
  function failLargeWrites(limit: number) {
    Storage.prototype.setItem = function quota(key: string, value: string) {
      if ((key === 'qp-recents-v1' || key === 'qp-dataset-v1') && value.length > limit) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    };
  }
  const bEntry = () => ({ name: 'B表.csv', savedAt: 'x', data: { name: 'B表.csv', colNames: ['x'], rows: [[1], [2]], textCols: [], savedAt: 'x' } });

  it('内存 recents 已被替换成不含活动大表的列表时，重试不得凭这份小列表放行', () => {
    useData.getState().importMatrix('B表.csv', ['x'], [[1], [2]]);
    failLargeWrites(5000);
    useData.getState().importMatrix('大表.csv', ['x', 'y'], bigRows);
    expect(useData.getState().recentsUnpersisted).toBe(true);
    useData.setState({ recents: [bEntry()] });
    expect(() => useData.getState().importMatrix('C.csv', ['x'], [[1], [2]])).toThrow(/最近数据集列表尚未保存/);
    expect(useData.getState().model.name).toBe('大表.csv');
    expect(recentNames()).toContain('大表.csv');
    expect(useData.getState().recents.find((r) => r.name === '大表.csv')?.data?.rows).toEqual(bigRows);
  });

  it('另一窗口写入最近列表时，本窗口未落盘的活动大表不被挤出，闸门仍拦截', () => {
    useData.getState().importMatrix('B表.csv', ['x'], [[1], [2]]);
    failLargeWrites(5000);
    useData.getState().importMatrix('大表.csv', ['x', 'y'], bigRows);
    expect(useData.getState().recentsUnpersisted).toBe(true);
    const foreign = JSON.stringify([bEntry()]);
    nativeSetItem.call(localStorage, 'qp-recents-v1', foreign);
    window.dispatchEvent(new StorageEvent('storage', { key: 'qp-recents-v1', newValue: foreign, storageArea: localStorage }));
    expect(recentNames()).toEqual(['大表.csv', 'B表.csv']);
    expect(() => useData.getState().importMatrix('C.csv', ['x'], [[1], [2]])).toThrow(/最近数据集列表尚未保存/);
    expect(useData.getState().model.name).toBe('大表.csv');
  });
});

describe('M3 clearPareto / resetDemo 删除业务键走对称簿记', () => {
  it('帕累托写盘配额失败后清空，导出的项目文件不再带旧的帕累托载荷', async () => {
    useData.getState().importMatrix('A.csv', ['x'], [[1], [2]]);
    Storage.prototype.setItem = function quota(key: string, value: string) {
      if (key === 'qp-pareto-v1') throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };
    expect(useData.getState().importPareto('机密缺陷', [{ name: '划伤', count: 3 }]).persisted).toBe(false);
    useData.getState().clearPareto();
    Storage.prototype.setItem = nativeSetItem;
    const exported = JSON.parse(await buildProjectJsonFull('1.43.0')) as { stores: Record<string, string> };
    expect(exported.stores['qp-pareto-v1']).toBeUndefined();
    expect(JSON.stringify(exported)).not.toContain('机密缺陷');
  });

  it('计数数据写盘配额失败后恢复演示，导出不含旧 attr 载荷且通过自校验', async () => {
    useData.getState().importMatrix('A.csv', ['x'], [[1], [2]]);
    Storage.prototype.setItem = function quota(key: string, value: string) {
      if (key === 'qp-attr-v1') throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };
    expect(useData.getState().importCounts('p', '机密P图', [1, 2, 3, 2], 50).persisted).toBe(false);
    useData.getState().resetDemo();
    Storage.prototype.setItem = nativeSetItem;
    const text = await buildProjectJsonFull('1.43.0');
    const exported = JSON.parse(text) as { stores: Record<string, string> };
    expect(exported.stores['qp-attr-v1']).toBeUndefined();
    expect(text).not.toContain('机密P图');
  });
});
