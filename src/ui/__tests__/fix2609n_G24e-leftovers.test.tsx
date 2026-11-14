/**
 * fix2609n · 第 8 批复审报出的收口(编排方补做):
 * (1) vite.config.ts 三斜线引用与 import 并存触发 eslint 错误(CI 的 npm run lint 会红);eslint 忽略复审临时目录;
 * (2) StrictNumberInput 出错时覆盖 border 简写而非追加 borderColor 长写,恢复合法后边框颜色不丢;
 * (3) 查找替换:store 没有更新提示时才补「未找到」,旧的无关提示不算;
 * (4) 导入弹窗「开始模拟采集」在导出快照期间被替换闸门拒绝时给出提示、不抛未捕获异常;
 * (5) 「另存为副本」在导出快照期间于分配副本名之前就被拒绝,副本序号不被消耗。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb, type DatasetSnapshot } from '../../platform/adapter';
import { buildProjectJsonFull } from '../../platform/project';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';
import { StrictNumberInput } from '../StrictNumberInput';
import { Modals } from '../shell/Modals';

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
const ROWS = [[3, 30], [1, 10], [2, 20]];
const rowsNow = () => useData.getState().model.subs.map((s) => s.vals);

beforeEach(() => {
  cleanup();
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({ page: 'worksheet', modal: null, busyOverlay: null, toast: null, selSub: null, openMenu: null });
  useData.getState().importMatrix('录入表.csv', ['x', 'y'], ROWS.map((r) => [...r]));
});
afterEach(async () => {
  if (pendingFinish) await pendingFinish();
  platform.datasetDb = null;
  cleanup();
});

describe('(1) lint 卫生', () => {
  it('vite.config.ts 不再同时使用三斜线引用与 vitest/config import', () => {
    const src = readFileSync('vite.config.ts', 'utf8');
    expect(src.includes('/// <reference types="vitest/config" />')).toBe(false);
    expect(src.includes("from 'vitest/config'")).toBe(true);
  });
  it('eslint 忽略复审代理的临时目录', () => {
    const src = readFileSync('eslint.config.js', 'utf8');
    expect(src).toContain("'src/__audit_scratch__'");
    expect(src).toContain("'.claude'");
  });
  it('eslint 对根目录配置文件通过(CI 的 npm run lint 口径)', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint();
    const results = await eslint.lintFiles(['vite.config.ts', 'eslint.config.js']);
    expect(results.flatMap((r) => r.messages.filter((m) => m.severity === 2).map((m) => `${r.filePath}: ${m.ruleId} ${m.message}`))).toEqual([]);
  }, 60_000);
});

describe('(2) StrictNumberInput 边框颜色', () => {
  it('非法 → 合法后,border 简写里的颜色仍在(不回落为 currentColor)', () => {
    const onCommit = vi.fn();
    render(<StrictNumberInput label="批量 N" value={1000} onCommit={onCommit} integer={{ min: 2, max: 1e6 }} style={{ border: '1px solid #cfd5dd', width: 100 }} />);
    const box = screen.getByRole('textbox', { name: '批量 N' }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: '250件' } });
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.style.borderColor).not.toBe('rgb(207, 213, 221)');
    fireEvent.change(box, { target: { value: '250' } });
    expect(box.getAttribute('aria-invalid')).toBeNull();
    expect(box.style.borderColor).toBe('rgb(207, 213, 221)');
    expect(box.style.borderWidth).toBe('1px');
    expect(onCommit).toHaveBeenLastCalledWith(250);
  });
});

describe('(3)(4)(5) 导出快照期间的入口', () => {
  it('查找替换被拒时:store 的「请稍后重试」提示不被「未找到」覆盖;旧的无关提示也不算作已提示', async () => {
    const finish = await startStalledExport();
    useApp.setState({ modal: 'findreplace' });
    useApp.getState().showToast('已复制 3 个单元格');
    render(<Modals />);
    fireEvent.change(screen.getByLabelText('查找数值'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('替换为'), { target: { value: '33' } });
    const btn = screen.getByRole('button', { name: '全部替换' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(useApp.getState().toast ?? '').toContain('请稍后重试');
    expect(useApp.getState().modal).toBe('findreplace');
    expect(rowsNow()).toEqual(ROWS);
    await finish();
  });

  it('导入弹窗「开始模拟采集」被替换闸门拒绝:提示原因,不抛未捕获异常,弹窗不关,表不变', async () => {
    const finish = await startStalledExport();
    useApp.setState({ modal: 'import', importTab: 'mes' });
    render(<Modals />);
    const btn = screen.getByRole('button', { name: /开始模拟采集/ });
    expect(() => fireEvent.click(btn)).not.toThrow();
    expect(useApp.getState().toast ?? '').toContain('未能启动模拟采集');
    expect(useApp.getState().toast ?? '').toContain('一致性快照');
    expect(useApp.getState().modal).toBe('import');
    expect(useData.getState().mesRunning).toBe(false);
    expect(rowsNow()).toEqual(ROWS);
    await finish();
  });

  it('另存为副本在导出快照期间于分配副本名之前被拒绝:副本序号不消耗,快照后首次另存仍得到「(副本)」', async () => {
    const finish = await startStalledExport();
    expect(() => useData.getState().saveAsCopy()).toThrow(/一致性快照/);
    expect(localStorage.getItem('qp-copy-sequences-v1')).toBeNull();
    await finish();
    const copy = useData.getState().saveAsCopy();
    expect(copy.name).toBe('录入表 (副本)');
  });
});
