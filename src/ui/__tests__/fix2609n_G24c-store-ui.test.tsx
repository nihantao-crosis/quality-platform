/**
 * fix2609n · G24c-store C2(第 7 批复审残余):项目导出一致性快照期间点菜单「新建工作表」/「另存为副本」或按 Ctrl+N,
 * 数据集替换闸门(beginDatasetIntent)抛出「项目正在生成一致性快照」——此前在事件处理器里成了未捕获异常，
 * 没有任何提示。现在调用方接住并如实提示原因：出现提示、不抛未捕获异常、不跳页、表不变。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { platform, type DatasetDb, type DatasetSnapshot } from '../../platform/adapter';
import { buildProjectJsonFull } from '../../platform/project';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, settlePendingDatasetWrites, useData } from '../../store/dataStore';
import { MenuBar } from '../shell/MenuBar';

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

let pendingFinish: (() => Promise<string>) | null = null;

/** 开始一次项目导出并停在「读本机库快照」处(导出租约持有中)。 */
async function startStalledExport() {
  const snap = deferred<DatasetSnapshot>();
  const db = stalledDb(snap.promise);
  platform.datasetDb = db;
  const exporting = buildProjectJsonFull('1.43.0');
  for (let i = 0; i < 100 && db.readSnapshot.mock.calls.length === 0; i++) await Promise.resolve();
  expect(db.readSnapshot).toHaveBeenCalled();
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

const ROWS = [[1, 10], [2, 20], [3, 30]];
const uncaught: unknown[] = [];
const onWindowError = (event: ErrorEvent) => {
  uncaught.push(event.error ?? event.message);
  event.preventDefault();
};

beforeEach(() => {
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({ page: 'dashboard', modal: null, busyOverlay: null, toast: null, openMenu: null });
  useData.getState().importMatrix('录入表.csv', ['x', 'y'], ROWS.map((r) => [...r]));
  uncaught.length = 0;
  window.addEventListener('error', onWindowError);
});

afterEach(async () => {
  window.removeEventListener('error', onWindowError);
  if (pendingFinish) await pendingFinish().catch(() => '');
  cleanup();
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  useApp.setState({ modal: null, busyOverlay: null, toast: null, openMenu: null });
});

const tableNow = () => ({ name: useData.getState().model.name, rows: useData.getState().model.subs.map((s) => s.vals) });

describe('C2 导出快照期间的新建/另存入口如实提示', () => {
  it('菜单「文件 → 新建工作表」:提示快照进行中，不抛异常、不跳页、表不变', async () => {
    render(<MenuBar wsName="录入表.csv" />);
    const finish = await startStalledExport();
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    expect(() => fireEvent.click(screen.getByRole('button', { name: /新建工作表/ }))).not.toThrow();
    expect(useApp.getState().toast ?? '').toMatch(/一致性快照/);
    expect(useApp.getState().toast ?? '').not.toMatch(/已新建/);
    expect(useApp.getState().page).toBe('dashboard');
    expect(tableNow()).toEqual({ name: '录入表.csv', rows: ROWS });
    expect(uncaught).toEqual([]);
    await finish();
    expect(tableNow()).toEqual({ name: '录入表.csv', rows: ROWS });
  });

  it('菜单「文件 → 另存为副本」:提示快照进行中，不抛异常、表不变', async () => {
    render(<MenuBar wsName="录入表.csv" />);
    const finish = await startStalledExport();
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    expect(() => fireEvent.click(screen.getByRole('button', { name: /另存为副本/ }))).not.toThrow();
    expect(useApp.getState().toast ?? '').toMatch(/一致性快照/);
    expect(useApp.getState().toast ?? '').not.toMatch(/已另存/);
    expect(tableNow()).toEqual({ name: '录入表.csv', rows: ROWS });
    expect(uncaught).toEqual([]);
    await finish();
    expect(tableNow()).toEqual({ name: '录入表.csv', rows: ROWS });
  });

  it('真实 App 的 Ctrl+N:提示快照进行中，无未捕获异常、不跳页、表不变；快照结束后 Ctrl+N 照常新建', async () => {
    render(<App />);
    const finish = await startStalledExport();
    const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(uncaught).toEqual([]);
    expect(useApp.getState().toast ?? '').toMatch(/一致性快照/);
    expect(useApp.getState().page).toBe('dashboard');
    expect(tableNow()).toEqual({ name: '录入表.csv', rows: ROWS });
    await finish();
    platform.datasetDb = null;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(useApp.getState().toast ?? '').toMatch(/已新建空白工作表/);
    expect(useApp.getState().page).toBe('worksheet');
    expect(useData.getState().model.name.startsWith('新建工作表_')).toBe(true);
  });
});
