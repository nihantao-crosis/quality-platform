/**
 * fix2609j · G17b-store 回归(2026-09-25 全面审查遗留 P2)：
 * - STORE-07：「恢复演示数据」删除业务键必须走 removeJson 簿记——受写保护的损坏原文不删，
 *   dirty 载荷不随导出复活，放弃的活动表不再维持「未持久化」离开警告；
 * - STORE-10：AQL 账本/帕累托/计数/偏好写入失败后，离开页面同样拦截(hasUnpersistedState 统一判定)，
 *   启动迁移写入失败也要提示；
 * - STORE-15：最近列表写入与校验同一名称口径(首尾空格)，旧版写下的首尾空格重名列表启动时迁移合并；
 * - GAP-7-15：项目导出快照期间的单格编辑暂存、导出后自动应用，不抛未捕获异常、不丢草稿(结构性编辑按 fix2609m A2 拒绝)；
 * - GAP-10-25：大表撤销栈被字节预算压缩时一次性告知，菜单如实显示可撤销层数。
 * 全部调用真实生产函数(useData / Worksheet / MenuBar / buildProjectJsonFull)，只模拟存储配额与本机库。
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb, type DatasetSnapshot } from '../../platform/adapter';
import { buildProjectJsonFull, projectStoreValidationError, QUARANTINE_STORAGE_KEY } from '../../platform/project';
import { AQL_STATE_STORAGE_KEY, useApp } from '../../store/appStore';
import * as dataStore from '../../store/dataStore';
import {
  cancelPendingDatasetWork,
  loadValidatedStoreJson,
  markActiveDataReplaced,
  settlePendingDatasetWrites,
  useData,
} from '../../store/dataStore';
import { Worksheet } from '../pages/Worksheet';
import { MenuBar } from '../shell/MenuBar';

const nativeSetItem = Storage.prototype.setItem;

function failWritesTo(...keys: string[]) {
  Storage.prototype.setItem = function quota(key: string, value: string) {
    if (keys.includes(key)) throw new DOMException('quota', 'QuotaExceededError');
    return nativeSetItem.call(this, key, value);
  };
}

function restoreWrites() {
  Storage.prototype.setItem = nativeSetItem;
}

/** 离开页面拦截：派发真实 beforeunload，返回是否被阻止。 */
function unloadBlocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function hasUnpersistedState(): boolean {
  const fn = (dataStore as unknown as { hasUnpersistedState?: () => boolean }).hasUnpersistedState;
  if (typeof fn !== 'function') throw new Error('dataStore 未导出 hasUnpersistedState()');
  return fn();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

function snapshotDb(snapshot: Promise<DatasetSnapshot>): DatasetDb & { readSnapshot: ReturnType<typeof vi.fn> } {
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

async function waitForCall(fn: ReturnType<typeof vi.fn>) {
  for (let i = 0; i < 50 && fn.mock.calls.length === 0; i++) await Promise.resolve();
  expect(fn).toHaveBeenCalled();
}

beforeEach(() => {
  restoreWrites();
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  // 让 AQL 账本与偏好在干净存储上重新落盘，清除上一个用例遗留的 dirty 标志。
  useApp.setState({ aqlLot: 120 + Math.floor(Math.random() * 1000), chartStyle: '经典' });
  useApp.setState({ page: 'worksheet', modal: null, busyOverlay: null, toast: null, selSub: null });
});

afterEach(async () => {
  cleanup();
  restoreWrites();
  vi.useRealTimers();
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.restoreAllMocks();
});

describe('STORE-07 恢复演示数据的删除簿记', () => {
  it('受写保护的损坏原文(隔离区写不下)不被恢复演示删除，且如实提示', () => {
    localStorage.setItem('qp-dataset-v1', '{"name":"未写完"');
    failWritesTo(QUARANTINE_STORAGE_KEY);
    expect(loadValidatedStoreJson('qp-dataset-v1')).toBeNull();
    expect(localStorage.getItem(QUARANTINE_STORAGE_KEY)).toBeNull();
    useData.getState().resetDemo();
    // 唯一恢复证据保留在原位，与「已禁止覆盖原值」的承诺一致
    expect(localStorage.getItem('qp-dataset-v1')).toBe('{"name":"未写完"');
    expect(useApp.getState().toast).toContain('已拒绝删除以保留恢复证据');
    expect(useData.getState().model.name).toBe('质检数据.mtw');
    // 腾出空间后再次恢复演示：先隔离成功再删除，导出不再被残留保护阻断
    restoreWrites();
    useData.getState().resetDemo();
    expect(localStorage.getItem('qp-dataset-v1')).toBeNull();
    expect(localStorage.getItem(QUARANTINE_STORAGE_KEY)).toContain('未写完');
  });

  it('活动表落盘失败后恢复演示：导出不带已放弃的数据集，离开警告随之解除', async () => {
    failWritesTo('qp-dataset-v1');
    expect(useData.getState().importMatrix('大表A.csv', ['a', 'b'], [[1, 2], [2, 3], [3, 4]]).persisted).toBe(false);
    expect(useData.getState().activeUnpersisted).toBe(true);
    restoreWrites();
    useData.getState().resetDemo();
    expect(useData.getState().model.name).toBe('质检数据.mtw');
    // 已放弃的表仍完整保留在已落盘的最近列表里，演示集本身无需持久化
    expect(localStorage.getItem('qp-recents-v1')).toContain('大表A.csv');
    expect(useData.getState().activeUnpersisted).toBe(false);
    expect(unloadBlocked()).toBe(false);
    const exported = JSON.parse(await buildProjectJsonFull('1.43.0')) as { stores: Record<string, string> };
    expect(exported.stores['qp-dataset-v1']).toBeUndefined();
  });
});

describe('STORE-10 非工作表业务数据写入失败时的离开拦截', () => {
  it('帕累托数据写入失败：hasUnpersistedState 为真，关闭页面被拦截；清除后解除', () => {
    expect(hasUnpersistedState()).toBe(false);
    failWritesTo('qp-pareto-v1');
    expect(useData.getState().importPareto('缺陷分类', [{ name: '划伤', count: 3 }]).persisted).toBe(false);
    expect(hasUnpersistedState()).toBe(true);
    expect(unloadBlocked()).toBe(true);
    restoreWrites();
    useData.getState().clearPareto();
    expect(hasUnpersistedState()).toBe(false);
    expect(unloadBlocked()).toBe(false);
  });

  it('P/C 计数写入失败同样拦截', () => {
    failWritesTo('qp-attr-v1');
    expect(useData.getState().importCounts('p', '装配线不良-9月', [1, 2, 3, 2], 50).persisted).toBe(false);
    expect(unloadBlocked()).toBe(true);
  });

  it('AQL 责任账本写入失败：拦截离开；重新落盘成功后解除', () => {
    failWritesTo(AQL_STATE_STORAGE_KEY);
    act(() => useApp.setState({ aqlLot: 777 }));
    expect(hasUnpersistedState()).toBe(true);
    expect(unloadBlocked()).toBe(true);
    restoreWrites();
    act(() => useApp.setState({ aqlLot: 778 }));
    expect(hasUnpersistedState()).toBe(false);
    expect(unloadBlocked()).toBe(false);
  });

  it('界面/分析参数写入失败同样拦截', () => {
    failWritesTo('qp-prefs-v1');
    act(() => useApp.setState({ chartStyle: '现代' }));
    expect(hasUnpersistedState()).toBe(true);
    expect(unloadBlocked()).toBe(true);
    restoreWrites();
    act(() => useApp.setState({ chartStyle: '经典' }));
    expect(unloadBlocked()).toBe(false);
  });

  it('项目导入成功即将重载时 markActiveDataReplaced 解除全部拦截', () => {
    failWritesTo('qp-pareto-v1');
    useData.getState().importPareto('缺陷分类', [{ name: '划伤', count: 3 }]);
    expect(unloadBlocked()).toBe(true);
    markActiveDataReplaced();
    expect(unloadBlocked()).toBe(false);
  });

  it('启动时 AQL 账本迁移写入失败：给出提示且之后离开被拦截(不再全程零信号)', async () => {
    vi.resetModules();
    failWritesTo(AQL_STATE_STORAGE_KEY);
    const freshApp = await import('../../store/appStore');
    const toast = freshApp.useApp.getState().toast ?? '';
    expect(toast).toContain('AQL 责任账本尚未写入本地存储');
    expect(freshApp.appUnpersistedStateLabels()).toContain('AQL 责任账本');
    restoreWrites();
    // 腾出空间后的下一次账本改动落盘成功，该模块实例恢复干净
    freshApp.useApp.setState({ aqlLot: 999 });
    expect(freshApp.appUnpersistedStateLabels()).toEqual([]);
  });
});

describe('STORE-15 最近列表名称口径(首尾空格)', () => {
  it('先后导入「批次A.csv」与「 批次A.csv」：写入即规范化，最近列表合法、项目可导出', async () => {
    useData.getState().importMatrix('批次A.csv', ['x'], [[1], [2]]);
    useData.getState().importMatrix(' 批次A.csv', ['x'], [[3], [4]]);
    expect(useData.getState().model.name).toBe('批次A.csv');
    const names = useData.getState().recents.map((entry) => entry.name);
    expect(names).toEqual(['批次A.csv']);
    const onDisk = JSON.parse(localStorage.getItem('qp-recents-v1') ?? '[]') as unknown;
    expect(projectStoreValidationError('qp-recents-v1', onDisk)).toBeNull();
    await expect(buildProjectJsonFull('1.43.0')).resolves.toContain('批次A.csv');
  });

  it('旧版留下的带空格条目遇到同名新导入(改名策略)：不按原始名并存，也不静默顶掉旧数据', () => {
    const legacy = {
      name: ' 批次A.csv', colNames: ['x'], rows: [[7], [8]], textCols: [], pendingCells: [], savedAt: '2026-09-01T00:00:00.000Z',
    };
    useData.setState({ recents: [{ name: legacy.name, savedAt: legacy.savedAt, data: legacy }] });
    const outcome = useData.getState().importMatrix('批次A.csv', ['x'], [[1], [2]], [], [], { onNameConflict: 'rename' });
    expect(outcome.persisted).toBe(true);
    const names = useData.getState().recents.map((entry) => entry.name);
    expect(names).toContain(' 批次A.csv');
    expect(new Set(names.map((name) => name.trim())).size).toBe(names.length);
    expect(projectStoreValidationError('qp-recents-v1', JSON.parse(localStorage.getItem('qp-recents-v1') ?? '[]'))).toBeNull();
  });

  it('旧版写下的首尾空格重名列表：启动时迁移合并，不再整表隔离清空无关条目', async () => {
    const entry = (name: string, v: number) => ({
      name, savedAt: `2026-09-0${v}T00:00:00.000Z`,
      data: { name, colNames: ['x'], rows: [[v], [v + 1]], textCols: [], pendingCells: [], savedAt: `2026-09-0${v}T00:00:00.000Z` },
    });
    const legacyList = [entry('批次B.csv', 3), entry(' 批次A.csv', 2), entry('批次A.csv', 1)];
    localStorage.setItem('qp-recents-v1', JSON.stringify(legacyList));
    vi.resetModules();
    const fresh = await import('../../store/dataStore');
    const names = fresh.useData.getState().recents.map((recent) => recent.name);
    expect(names).toEqual(['批次B.csv', ' 批次A.csv']);
    // 原文完整保留在隔离区，可在「选项」中找回被合并掉的旧条目
    expect(localStorage.getItem(QUARANTINE_STORAGE_KEY)).toContain('批次A.csv');
    expect(projectStoreValidationError('qp-recents-v1', JSON.parse(localStorage.getItem('qp-recents-v1') ?? '[]'))).toBeNull();
  });
});

describe('GAP-7-15 项目导出快照期间的工作表编辑', () => {
  it('真实 Worksheet：导出生成快照时回车提交不抛错、退出编辑态，快照完成后自动应用且导出内容一致', async () => {
    useData.getState().importMatrix('录入表.csv', ['x', 'y'], [[1, 2], [3, 4], [5, 6]]);
    const snapshot = deferred<DatasetSnapshot>();
    const db = snapshotDb(snapshot.promise);
    platform.datasetDb = db;
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
    window.addEventListener('error', onError);
    render(<Worksheet />);
    const exporting = buildProjectJsonFull('1.43.0');
    await waitForCall(db.readSnapshot);

    const cell = document.querySelector('td.worksheet-editable-cell') as HTMLElement;
    fireEvent.doubleClick(cell);
    const input = screen.getByDisplayValue('1');
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(errors).toEqual([]);
    expect(screen.queryByDisplayValue('42')).toBeNull(); // 已退出编辑态
    expect(useApp.getState().toast).toContain('快照完成后自动应用');
    expect(useData.getState().model.subs[0].vals[0]).toBe(1); // 快照期间数据集不变

    snapshot.resolve({ revision: 1, datasets: [] });
    const text = await exporting;
    await Promise.resolve();
    window.removeEventListener('error', onError);
    const exported = JSON.parse(text) as { stores: Record<string, string> };
    expect(JSON.parse(exported.stores['qp-dataset-v1']).rows[0][0]).toBe(1); // 一致性快照不含半途编辑
    expect(useData.getState().model.subs[0].vals[0]).toBe(42); // 草稿未丢，已应用
  });

  it('store 层：单格编辑/列重命名按顺序暂存并在导出后依次应用；结构性编辑与撤销明确拒绝(fix2609m A2)而非抛错', async () => {
    useData.getState().importMatrix('录入表.csv', ['x', 'y'], [[1, 2], [3, 4], [5, 6]]);
    useData.getState().updateCell(0, 1, 20);
    const snapshot = deferred<DatasetSnapshot>();
    const db = snapshotDb(snapshot.promise);
    platform.datasetDb = db;
    const exporting = buildProjectJsonFull('1.43.0');
    await waitForCall(db.readSnapshot);

    expect(() => useData.getState().updateCell(0, 0, 42)).not.toThrow();
    expect(() => useData.getState().updateCell(1, 0, 43)).not.toThrow();
    expect(() => useData.getState().renameColumn(0, '新名')).not.toThrow();
    // fix2609m A2:改变下标的编辑在快照期间拒绝、不排队(排队重放会写错行/多删行)
    expect(useData.getState().deleteRow(2)).toBe(false);
    expect(useData.getState().undoEdit()).toBe(false); // 撤销同样拒绝，且不先弹栈
    expect(useData.getState().addFormulaColumn('z', 'C1+C2')).toContain('项目备份正在生成');
    expect(useData.getState().model.subs.map((s) => s.vals)).toEqual([[1, 20], [3, 4], [5, 6]]);

    snapshot.resolve({ revision: 1, datasets: [] });
    await exporting;
    await Promise.resolve();
    const st = useData.getState();
    // 依次应用：42 → 43 → 改名；被拒绝的删行/撤销不重放
    expect(st.model.colNames).toEqual(['新名', 'y']);
    expect(st.model.subs.map((s) => s.vals)).toEqual([[42, 20], [43, 4], [5, 6]]);
    expect(() => useData.getState().updateCell(0, 0, 9)).not.toThrow();
    expect(useData.getState().model.subs[0].vals[0]).toBe(9);
  });
});

describe('GAP-10-25 撤销栈字节预算的可见性', () => {
  it('小表菜单显示真实可撤销层数；无可撤销时禁用', () => {
    useData.getState().importMatrix('小表.csv', ['x'], [[1], [2], [3]]);
    render(<MenuBar wsName="小表.csv" />);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const undo0 = screen.getByRole('button', { name: /撤销编辑/ });
    expect(undo0.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      useData.getState().updateCell(0, 0, 5);
      useData.getState().updateCell(1, 0, 6);
    });
    const undo2 = screen.getByRole('button', { name: /撤销编辑/ });
    expect(undo2.textContent).toContain('可撤销 2 步');
    expect(undo2.getAttribute('aria-disabled')).toBeNull();
  });

  it('20 万行×5 列：撤销栈被预算压到 1 层时一次性提示，菜单标明只剩 1 步', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => [i, i + 1, i + 2, i + 3, i + 4]);
    failWritesTo('qp-dataset-v1', 'qp-recents-v1'); // 大表写不进 localStorage 与本用例无关，避免 jsdom 序列化开销
    useData.getState().importMatrix('满额班次.csv', ['a', 'b', 'c', 'd', 'e'], rows);
    const original = useApp.getState().showToast;
    const toasts: string[] = [];
    useApp.setState({ showToast: (m: string) => { toasts.push(m); original(m); } });
    try {
      act(() => {
        for (let i = 0; i < 4; i++) useData.getState().updateCell(i, 0, 1000 + i);
      });
    } finally {
      useApp.setState({ showToast: original });
    }
    expect(useData.getState().undoStack).toHaveLength(1);
    const budgetToasts = toasts.filter((m) => m.includes('撤销历史'));
    expect(budgetToasts).toHaveLength(1);
    expect(budgetToasts[0]).toContain('仅可撤销 1 步');
    render(<MenuBar wsName="满额班次.csv" />);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const undo = screen.getByRole('button', { name: /撤销编辑/ });
    expect(undo.textContent).toContain('可撤销 1 步');
    expect(undo.textContent).toContain('内存预算');
  }, 60_000);
});
