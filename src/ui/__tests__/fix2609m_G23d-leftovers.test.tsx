/**
 * fix2609m · 第 7 批各组自报的跨组小尾巴(编排方补做):
 * (1) 排序 / 查找替换对话框在项目导出一致性快照期间被 store 拒绝后,不再关闭对话框、不再提示「已排序 / 已替换」;
 * (2) 偏好隔离失败拒绝导出的文案带释放空间出路,选项页与导出侧共用同一常量;
 * (3) Word/PPT 导出的 OOXML 清洗不再用后行断言(见 fix2609m_G23c-regex);
 * (4) 能力页规格编辑区固定 key:逐键输入途中前缀触发分析分支切换时,输入框不再重挂载、焦点与编辑会话不丢。
 * 全部走真实组件与真实 store。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb, type DatasetSnapshot } from '../../platform/adapter';
import { STORAGE_SPACE_RELEASE_HINT, buildProjectJsonFull } from '../../platform/project';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';
import { Modals } from '../shell/Modals';
import { LOCAL_SPACE_RELEASE_HINT } from '../shell/OptionsModal';
import { Capability } from '../pages/Capability';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);

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

describe('(1) 排序 / 查找替换对话框在导出快照期间被拒绝', () => {
  it('排序:点「排序」后对话框仍开着、无「已按…排序」提示、表不变;快照完成后再点才排序', async () => {
    const finish = await startStalledExport();
    useApp.setState({ modal: 'sort' });
    render(<Modals />);
    fireEvent.click(screen.getByRole('button', { name: '排序' }));
    expect(useApp.getState().modal).toBe('sort');
    expect(useApp.getState().toast ?? '').not.toContain('已按');
    expect(useApp.getState().toast ?? '').toContain('请稍后重试');
    expect(rowsNow()).toEqual(ROWS);
    await finish();
    fireEvent.click(screen.getByRole('button', { name: '排序' }));
    expect(useApp.getState().modal).toBeNull();
    expect(useApp.getState().toast ?? '').toContain('已按「x」升序排序');
    expect(rowsNow()).toEqual([[1, 10], [2, 20], [3, 30]]);
  });

  it('查找替换:快照期间「全部替换」不关闭、不提示「已替换」、数据不变;之后正常替换', async () => {
    const finish = await startStalledExport();
    useApp.setState({ modal: 'findreplace' });
    render(<Modals />);
    fireEvent.change(screen.getByLabelText('查找数值'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('替换为'), { target: { value: '33' } });
    const btn = screen.getByRole('button', { name: '全部替换' }) as HTMLButtonElement;
    // fix2609n G24b B3(第 7 批复审 P3):按钮必须可点,否则本用例空转通过、测不到「快照期间被拒不报成功」
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(useApp.getState().modal).toBe('findreplace');
    expect(useApp.getState().toast ?? '').not.toContain('已替换');
    expect(useApp.getState().toast ?? '').toContain('请稍后重试');
    expect(rowsNow()).toEqual(ROWS);
    await finish();
    fireEvent.click(screen.getByRole('button', { name: '全部替换' }));
    expect(useApp.getState().modal).toBeNull();
    expect(useApp.getState().toast ?? '').toContain('已替换 1 处');
    expect(rowsNow()).toEqual([[3, 33], [1, 10], [2, 20]]);
  });
});

describe('(2) 释放空间出路文案同源', () => {
  it('选项页常量与导出侧常量是同一份', () => {
    expect(LOCAL_SPACE_RELEASE_HINT).toBe(STORAGE_SPACE_RELEASE_HINT);
    expect(STORAGE_SPACE_RELEASE_HINT).toContain('最近数据集');
  });
});

describe('(4) 能力页规格编辑区在分析分支切换时不重挂载', () => {
  it('小 σ 数据逐键输入 LSL「2」触发「规格超 1000σ」确认分支:同一个输入框、焦点仍在、草稿保留', () => {
    // σ≈0.0015:LSL=2 距均值 25 超过 1000σ → awaiting-ack 分支;24.9 / 25.1 只有约 70σ,初始为正常分支
    const rows = Array.from({ length: 25 }, (_, i) => Array.from({ length: 5 }, (_, j) => 25 + ((((i * 7 + j * 3) % 11) - 5) * 0.0005)));
    useData.getState().importMatrix('能力.csv', ['C1', 'C2', 'C3', 'C4', 'C5'], rows);
    useApp.setState({ page: 'capability', lsl: 24.9, tgt: 25, usl: 25.1, lslOn: true, uslOn: true, spcDataLayout: 'rows', capabilityWarningAcknowledgement: null });
    render(<Capability T={T} />);
    expect(document.body.textContent).not.toContain('等待确认');
    const lsl = screen.getByRole('textbox', { name: 'LSL 下限' }) as HTMLInputElement;
    lsl.focus();
    fireEvent.change(lsl, { target: { value: '' } });
    fireEvent.change(lsl, { target: { value: '2' } });
    expect(useApp.getState().lsl).toBe(2);
    expect(document.body.textContent).toContain('等待确认');
    expect(screen.getByRole('textbox', { name: 'LSL 下限' })).toBe(lsl);
    expect(document.activeElement).toBe(lsl);
    expect(lsl.value).toBe('2');
    // 继续键入回到正常分支,仍是同一个元素
    fireEvent.change(lsl, { target: { value: '24' } });
    fireEvent.change(lsl, { target: { value: '24.' } });
    fireEvent.change(lsl, { target: { value: '24.9' } });
    expect(useApp.getState().lsl).toBe(24.9);
    expect(document.body.textContent).not.toContain('等待确认');
    expect(screen.getByRole('textbox', { name: 'LSL 下限' })).toBe(lsl);
    expect(document.activeElement).toBe(lsl);
  });
});
