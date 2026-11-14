/**
 * fix2609n · 886391c 独立复审报出的收口(编排方补做):
 * (1) 查找替换按 toast 序号而非文本判断 store 是否已提示:连点两次同一拒绝原因时不再被「未找到」覆盖;
 *     非导出期间 store 未提示、旧的无关提示仍在 → 仍补「未找到可替换的值」;
 * (2) 回看的 mustStash 路径在导出快照期间:可读提示、resolve(false)、无未处理 rejection、编辑保留;
 * (3) prefs 其它字段与内嵌 AQL 账本同时损坏时,隔离区 detail 同时含两种原因;
 * (4) DOE 水平值 / 随机数据参数框出错时覆盖 border 简写(与 StrictNumberInput 同法)——源码断言。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb, type DatasetSnapshot } from '../../platform/adapter';
import { buildProjectJsonFull } from '../../platform/project';
import { auditAqlLedger, freshSwitchStatus, recordInspection, type SwitchStatus } from '../../core';
import { useApp } from '../../store/appStore';
import { useAnalyses } from '../../store/analyses';
import { cancelPendingDatasetWork, settlePendingDatasetWrites, useData } from '../../store/dataStore';
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
const ticks = async (n: number) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const ROWS = [[3, 30], [1, 10], [2, 20]];
const rowsNow = () => useData.getState().model.subs.map((s) => [...s.vals]);
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeAll(() => { process.on('unhandledRejection', onUnhandled); });
afterAll(() => { process.off('unhandledRejection', onUnhandled); });

beforeEach(() => {
  cleanup();
  unhandled.length = 0;
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useAnalyses.setState({ saved: [], lastError: null });
  useApp.setState({ page: 'worksheet', modal: null, busyOverlay: null, toast: null, selSub: null, openMenu: null });
  useData.getState().importMatrix('录入表.csv', ['x', 'y'], ROWS.map((r) => [...r]));
});
afterEach(async () => {
  if (pendingFinish) await pendingFinish();
  platform.datasetDb = null;
  cleanup();
});

function fillFindReplace(find: string, repl: string) {
  fireEvent.change(screen.getByLabelText('查找数值'), { target: { value: find } });
  fireEvent.change(screen.getByLabelText('替换为'), { target: { value: repl } });
  return screen.getByRole('button', { name: '全部替换' }) as HTMLButtonElement;
}

describe('(1) 查找替换的提示判断按序号', () => {
  it('非导出期间 applyEdit 被拒:连点两次都显示拒绝原因,不被「未找到」覆盖', () => {
    // 真实 applyEdit 的 worksheetMutationError:待录入坐标越界(内存态被污染时 store 的防线)
    useData.setState({ pendingCells: [{ row: 99, col: 0 }] });
    useApp.setState({ modal: 'findreplace' });
    render(<Modals />);
    const btn = fillFindReplace('30', '33');
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    const first = useApp.getState().toast ?? '';
    expect(first).toMatch(/^工作表编辑已拒绝：/);
    fireEvent.click(btn);
    expect(useApp.getState().toast).toBe(first);
    expect(useApp.getState().modal).toBe('findreplace');
    expect(rowsNow()).toEqual(ROWS);
  });

  it('非导出期间替换返回 0 且 store 未提示、旧的无关提示仍在:补「未找到可替换的值」', () => {
    const real = useData.getState().findReplace;
    useData.setState({ findReplace: (find, replace, col) => (replace == null ? real(find, null, col) : 0) });
    useApp.setState({ modal: 'findreplace' });
    useApp.getState().showToast('已复制 3 个单元格');
    render(<Modals />);
    const btn = fillFindReplace('30', '33');
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(useApp.getState().toast).toBe('未找到可替换的值');
    expect(useApp.getState().modal).toBe('findreplace');
  });
});

describe('(2) 回看 mustStash 在导出快照期间', () => {
  it('resolve(false)、提示副本未能保存并请稍后重试、无未处理 rejection、编辑保留;快照后回看成功', async () => {
    useApp.setState({ page: 'summary' }); // 保存的是当前页面的分析;工作表页没有可保存的分析
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved).not.toBeNull();
    useData.getState().updateCell(0, 0, 55.5);
    await settlePendingDatasetWrites();
    expect(rowsNow()[0][0]).toBe(55.5);
    const finish = await startStalledExport();
    await expect(useAnalyses.getState().restore(saved!.id)).resolves.toBe(false);
    await ticks(30);
    const toast = useApp.getState().toast ?? '';
    expect(toast).toContain('副本未能保存');
    expect(toast).toContain('一致性快照');
    expect(toast).toContain('请稍后重试');
    expect(rowsNow()[0][0]).toBe(55.5);
    expect(localStorage.getItem('qp-copy-sequences-v1')).toBeNull();
    await finish();
    expect(unhandled).toEqual([]);
    await expect(useAnalyses.getState().restore(saved!.id)).resolves.toBe(true);
    await settlePendingDatasetWrites();
    expect(rowsNow()).toEqual(ROWS);
    expect(unhandled).toEqual([]);
  });
});

describe('(3) prefs 隔离原因合并', () => {
  const PREFS = 'qp-prefs-v1';
  const QK = 'qp-quarantine-v1';
  let clock = 0;
  const at = () => new Date(Date.UTC(2026, 5, 1) + (clock += 90_000)).toISOString();
  function ledger(): SwitchStatus {
    let s = freshSwitchStatus();
    const lot = (d: number, id: string) => { s = recordInspection(s, { lot: 500, level: 'II', aql: 2.5, regime: 'percent', nonconforming: d, batchId: id, inspector: '质检乙', inspectedAt: at() } as never); };
    lot(0, 'B1'); lot(4, 'B2'); lot(0, 'B3'); lot(1, 'B4');
    return JSON.parse(JSON.stringify(s)) as SwitchStatus;
  }
  const aqlFields = (sw: SwitchStatus) => ({ aqlLot: 500, aqlLevel: 'II', aqlAQL: 2.5, aqlRegime: 'percent', aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: sw });
  const prefs = (sw: SwitchStatus, extra: Record<string, unknown> = {}) => JSON.stringify({ state: { chartStyle: '经典', showGrid: true, lsl: 1, usl: 3, tgt: 2, ...aqlFields(sw), ...extra }, version: 2 });
  const quarantine = () => JSON.parse(localStorage.getItem(QK) ?? '{}') as Record<string, { raw: string; detail: string }>;

  it('独立键缺失 + 内嵌账本被篡改 + 其它字段坏:隔离区一条,detail 同时含两种原因,AQL 锁定', async () => {
    const tampered = ledger(); tampered.switchingScore = 9;
    expect(auditAqlLedger(ledger()).status).toBe('verified');
    expect(auditAqlLedger(tampered).status).toBe('mismatch');
    localStorage.clear();
    localStorage.setItem(PREFS, prefs(tampered, { mysteryKey: 1 }));
    vi.resetModules();
    const store = (await import('../../store/appStore')).useApp;
    await ticks(20);
    const q = quarantine();
    expect(Object.keys(q)).toEqual([PREFS]);
    expect(q[PREFS].detail).toContain('非白名单字段');
    expect(q[PREFS].detail).toContain('旧偏好内嵌的 AQL 责任账本未通过校验');
    expect(store.getState().aqlLedgerFault).not.toBeNull();
    expect(localStorage.getItem('qp-aql-state-v1')).toBeNull();
    vi.resetModules();
  });
});

describe('(4) 同族参数框出错时覆盖 border 简写', () => {
  it('Doe.tsx / Modals.tsx 不再在 border 简写上追加 borderColor 长写', () => {
    for (const file of ['src/ui/pages/Doe.tsx', 'src/ui/shell/Modals.tsx', 'src/ui/StrictNumberInput.tsx']) {
      const src = readFileSync(file, 'utf8');
      expect(src.includes("{ borderColor: '#c22f2f' }"), file).toBe(false);
      expect(src.includes('borderColor: INVALID_BORDER'), file).toBe(false);
    }
  });
});
