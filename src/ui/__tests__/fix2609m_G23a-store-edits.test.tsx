/**
 * fix2609m · G23a-store A2 回归(最终对抗复审 G17b P2)：项目导出一致性快照期间，
 * 改变行/列下标或表结构的编辑(删行/删列/插列/加子组/排序/查找替换/撤销/重做)一律拒绝、不排队——
 * 此前按调用时下标捕获闭包排队，快照结束后依次重放到已被前序结构编辑改过的表上，静默写错行/多删行。
 * 只有不改变下标的单格编辑/列重命名仍排队，重放后写到用户看到的那一格；拒绝时不再弹成功提示。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb, type DatasetSnapshot } from '../../platform/adapter';
import { buildProjectJsonFull } from '../../platform/project';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, settlePendingDatasetWrites, useData } from '../../store/dataStore';
import { Worksheet } from '../pages/Worksheet';
import { MenuBar, undoRedoToast } from '../shell/MenuBar';
import { HelpModal } from '../shell/HelpModal';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

function stalledDb(snapshot: Promise<DatasetSnapshot>): DatasetDb & { readSnapshot: ReturnType<typeof vi.fn> } {
  return {
    async put() {},
    async insert() { return true; },
    async get() { return null; },
    async list() { return []; },
    async remove() { return false; },
    async clear(opId) { return { opId, committed: true, removed: 0 }; },
    async clearStatus() { return null; },
    async stats() { return { count: 0, total_bytes: 0, path: ':memory:' }; },
    readSnapshot: vi.fn(() => snapshot),
  };
}

async function untilCalled(fn: ReturnType<typeof vi.fn>) {
  for (let i = 0; i < 100 && fn.mock.calls.length === 0; i++) await Promise.resolve();
  expect(fn).toHaveBeenCalled();
}

let pendingFinish: (() => Promise<string>) | null = null;

/** 开始一次项目导出并停在「读本机库快照」处；返回 finish() 完成导出并等暂存编辑重放(断言失败时由 afterEach 收尾)。 */
async function startStalledExport() {
  const snap = deferred<DatasetSnapshot>();
  const db = stalledDb(snap.promise);
  platform.datasetDb = db;
  const exporting = buildProjectJsonFull('1.43.0');
  await untilCalled(db.readSnapshot);
  const finish = async () => {
    pendingFinish = null;
    snap.resolve({ revision: 1, datasets: [] });
    const text = await exporting;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return text;
  };
  pendingFinish = finish;
  return finish;
}

const ROWS = [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50]];
const rowsNow = () => useData.getState().model.subs.map((s) => s.vals);

beforeEach(() => {
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({ page: 'worksheet', modal: null, busyOverlay: null, toast: null, selSub: null });
  useData.getState().importMatrix('录入表.csv', ['x', 'y'], ROWS.map((r) => [...r]));
});

afterEach(async () => {
  if (pendingFinish) await pendingFinish().catch(() => '');
  cleanup();
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.restoreAllMocks();
});

describe('A2 导出快照期间结构性编辑被拒绝，单格编辑排队后写到正确的格', () => {
  it('真实 Worksheet：× 连点两次 → 两次都被拒绝、不提示「已删除」，导出后表不变', async () => {
    render(<Worksheet />);
    const finish = await startStalledExport();
    const del = () => screen.getAllByRole('button').find((b) => /^删除(行|子组) 2$/.test(b.getAttribute('aria-label') ?? ''));
    fireEvent.click(del()!);
    const toast1 = useApp.getState().toast ?? '';
    expect(toast1).toMatch(/稍后重试/);
    expect(toast1).not.toMatch(/已删除/);
    fireEvent.click(del()!);
    expect(useApp.getState().toast ?? '').not.toMatch(/已删除/);
    expect(rowsNow()).toEqual(ROWS);
    await finish();
    expect(rowsNow()).toEqual(ROWS);
  });

  it('真实 Worksheet：列头 × 删除测量列被拒绝时不提示「已删除测量列」', async () => {
    render(<Worksheet />);
    const finish = await startStalledExport();
    fireEvent.click(screen.getByRole('button', { name: '删除测量列：y' }));
    expect(useApp.getState().toast ?? '').toMatch(/稍后重试/);
    expect(useApp.getState().toast ?? '').not.toMatch(/已删除测量列/);
    await finish();
    expect(useData.getState().model.colNames).toEqual(['x', 'y']);
  });

  it('store 层：deleteRow(0) 被拒，按显示布局编辑 index 2 → 导出后写到原第 3 行', async () => {
    const finish = await startStalledExport();
    expect(useData.getState().deleteRow(0)).toBe(false);
    expect(rowsNow()[2]).toEqual([3, 30]);
    useData.getState().updateCell(2, 0, 99);
    expect(rowsNow()).toEqual(ROWS); // 快照期间数据不变
    await finish();
    expect(rowsNow()).toEqual([[1, 10], [2, 20], [99, 30], [4, 40], [5, 50]]);
  });

  it('store 层：排序被拒，编辑首行 → 导出后写到原首行', async () => {
    const finish = await startStalledExport();
    expect(useData.getState().sortBy(0, false)).toBe(false);
    useData.getState().updateCell(0, 1, 111);
    await finish();
    expect(rowsNow()).toEqual([[1, 111], [2, 20], [3, 30], [4, 40], [5, 50]]);
  });

  it('store 层：删列/插列/加子组/查找替换/撤销/重做全部拒绝且不排队；列重命名仍排队', async () => {
    useData.getState().updateCell(4, 1, 55);
    useData.getState().undoEdit(); // 形成一层可重做
    useData.getState().updateCell(4, 1, 51); // 再形成一层可撤销
    const before = rowsNow();
    const finish = await startStalledExport();
    expect(useData.getState().deleteColumn(1)).toBe(false);
    expect(useData.getState().insertColumn()).toBe(false);
    expect(useData.getState().addSubgroupRow()).toBe(false);
    expect(useData.getState().findReplace(3, 33, -1)).toBe(0);
    expect(useData.getState().findReplace(3, null, -1)).toBe(1); // 只计数(只读)照常可用
    expect(useData.getState().undoEdit()).toBe(false);
    expect(useData.getState().redoEdit()).toBe(false);
    useData.getState().renameColumn(0, '新名');
    expect(rowsNow()).toEqual(before);
    await finish();
    const st = useData.getState();
    expect(st.model.colNames).toEqual(['新名', 'y']);
    expect(rowsNow()).toEqual(before);
    expect(st.model.subs.length).toBe(5);
  });

  it('菜单「编辑 → 撤销」与提示函数：快照期间明确提示被拒绝，不写「已暂存」/「已撤销」', async () => {
    useData.getState().updateCell(0, 0, 42);
    render(<MenuBar wsName="录入表.csv" />);
    const finish = await startStalledExport();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: /撤销编辑/ }));
    const toast = useApp.getState().toast ?? '';
    expect(toast).toMatch(/撤销.*稍后重试/);
    expect(toast).not.toMatch(/已暂存|已撤销/);
    expect(undoRedoToast('redo', useData.getState().redoEdit())).toMatch(/重做.*稍后重试/);
    await finish();
    expect(rowsNow()[0][0]).toBe(42); // 撤销未排队，导出后也不会被重放
    expect(undoRedoToast('undo', useData.getState().undoEdit())).toBe('已撤销上一次数据编辑');
    expect(rowsNow()[0][0]).toBe(1);
  });

  it('帮助：项目备份期间的撤销/重做写明会被拒绝、请稍后重试', () => {
    render(<HelpModal onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '数据操作' }));
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/项目备份生成期间的撤销\/重做会被拒绝[,，]请稍后重试/);
    expect(text).not.toMatch(/撤销\/重做先暂存/);
  });
});
