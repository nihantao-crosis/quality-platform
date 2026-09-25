/** pendingCells 资源/坐标不变量：项目、SQLite 恢复与运行时导入必须原子 fail-closed。 */
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_IMPORT_DATA_CELLS,
  worksheetPendingCellsError,
} from '../../core';
import { platform, type DatasetDb } from '../../platform/adapter';
import { applyProjectText, projectStoreValidationError } from '../../platform/project';
import {
  cancelPendingDatasetWork,
  hydrateActiveFromVault,
  useData,
  type PendingCell,
} from '../../store/dataStore';
import { useApp } from '../../store/appStore';
import { Modals } from '../shell/Modals';

function dataset(name: string, pendingCells: PendingCell[]) {
  return {
    name,
    colNames: ['C1'],
    rows: [[1], [2]],
    textCols: [],
    pendingCells,
    savedAt: '2026-08-13T00:00:00.000Z',
  };
}

function projectText(data: ReturnType<typeof dataset>): string {
  return JSON.stringify({
    format: 'quality-platform-project',
    formatVersion: 4,
    appVersion: '1.43.0',
    exportedAt: '2026-08-13T00:00:00.000Z',
    stores: { 'qp-dataset-v1': JSON.stringify(data) },
  });
}

function observingDb(getValue: string | null = null) {
  const put = vi.fn(async () => undefined);
  const get = vi.fn(async () => getValue);
  const list = vi.fn(async () => []);
  const remove = vi.fn(async () => false);
  const clear = vi.fn(async (opId: string) => ({ opId, committed: true as const, removed: 0 }));
  const db: DatasetDb = {
    put,
    get,
    list,
    remove,
    clear,
    clearStatus: vi.fn(async () => null),
    stats: vi.fn(async () => ({ count: 0, total_bytes: 0, path: ':memory:' })),
  };
  return { db, put, get, list, remove, clear };
}

beforeEach(() => {
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({ modal: null, busyOverlay: null, toast: null });
});

afterEach(() => {
  cancelPendingDatasetWork();
  platform.datasetDb = null;
  useApp.setState({ modal: null, busyOverlay: null, toast: null });
  vi.restoreAllMocks();
});

describe('pendingCells 共享不变量', () => {
  it('先按 rows×cols 有界再遍历，超量夹具不会触碰任何元素', () => {
    const touched = vi.fn();
    const unreadable = {} as PendingCell;
    Object.defineProperties(unreadable, {
      row: { get: () => { touched(); throw new Error('不应遍历'); } },
      col: { get: () => { touched(); throw new Error('不应遍历'); } },
    });
    const overCapacity = [{ row: 0, col: 0 }, { row: 1, col: 0 }, unreadable];

    expect(worksheetPendingCellsError(overCapacity, { rows: 2, cols: 1 }))
      .toContain('数量 3 超过待录入坐标上限 2');
    expect(touched).not.toHaveBeenCalled();

    // 稀疏数组只占很小夹具内存，同时证明全局单元格预算也在遍历前生效。
    const overGlobalLimit = new Array<PendingCell>(MAX_IMPORT_DATA_CELLS + 1);
    expect(worksheetPendingCellsError(overGlobalLimit, { rows: 200_000, cols: 11 }))
      .toContain(`上限 ${MAX_IMPORT_DATA_CELLS.toLocaleString()}`);
  });

  it('运行时 importMatrix 对超量、重复与越界坐标均原子拒绝，不改 store/localStorage/SQLite', () => {
    useData.getState().importMatrix('当前表', ['x'], [[10], [20]]);
    cancelPendingDatasetWork();
    const fake = observingDb();
    platform.datasetDb = fake.db;
    const beforeModel = useData.getState().model;
    const beforePending = useData.getState().pendingCells;
    const beforeRecents = useData.getState().recents;
    const beforeActive = localStorage.getItem('qp-dataset-v1');
    const beforeRecentJson = localStorage.getItem('qp-recents-v1');

    expect(() => useData.getState().importMatrix(
      '超量表', ['x'], [[1], [2]], [],
      [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 0, col: 0 }],
    )).toThrow(/pendingCells 数量 3.*上限 2/);
    expect(() => useData.getState().importMatrix(
      '重复表', ['x'], [[1], [2]], [],
      [{ row: 0, col: 0 }, { row: 0, col: 0 }],
    )).toThrow(/pendingCells 包含重复坐标/);
    expect(() => useData.getState().importMatrix(
      '越界表', ['x'], [[1], [2]], [], [{ row: 2, col: 0 }],
    )).toThrow(/pendingCells 坐标越界/);

    expect(useData.getState().model).toBe(beforeModel);
    expect(useData.getState().pendingCells).toBe(beforePending);
    expect(useData.getState().recents).toBe(beforeRecents);
    expect(localStorage.getItem('qp-dataset-v1')).toBe(beforeActive);
    expect(localStorage.getItem('qp-recents-v1')).toBe(beforeRecentJson);
    expect(fake.put).not.toHaveBeenCalled();
  });

  it('项目导入在任何 store/SQLite 写入前拒绝超量与重复坐标', async () => {
    localStorage.setItem('qp-specs-v1', JSON.stringify({ 当前表: { lsl: 0, tgt: 1, usl: 2 } }));
    const oldSpecs = localStorage.getItem('qp-specs-v1');
    const fake = observingDb();
    platform.datasetDb = fake.db;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');

    const oversized = await applyProjectText(projectText(dataset('超量项目', [
      { row: 0, col: 0 }, { row: 1, col: 0 }, { row: 0, col: 0 },
    ])));
    expect(oversized).toMatchObject({ lockRequired: false });
    expect(oversized.error).toContain('pendingCells 数量 3');

    const duplicated = await applyProjectText(projectText(dataset('重复项目', [
      { row: 0, col: 0 }, { row: 0, col: 0 },
    ])));
    expect(duplicated).toMatchObject({ lockRequired: false });
    expect(duplicated.error).toContain('pendingCells 包含重复坐标');

    expect(localStorage.getItem('qp-specs-v1')).toBe(oldSpecs);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(fake.put).not.toHaveBeenCalled();
    expect(fake.list).not.toHaveBeenCalled();
    expect(fake.remove).not.toHaveBeenCalled();
    expect(fake.clear).not.toHaveBeenCalled();
  });

  it('项目 UI 对安全校验失败不安排 reload', async () => {
    const badProject = projectText(dataset('重复项目', [
      { row: 0, col: 0 }, { row: 0, col: 0 },
    ]));
    vi.spyOn(platform, 'pickImportFile').mockResolvedValue({
      name: 'duplicate-pending.qproj',
      contents: badProject,
    });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    useApp.setState({ modal: 'import' });
    render(<Modals />);

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await waitFor(() => expect(useApp.getState().toast).toContain('pendingCells 包含重复坐标'));
    expect(useApp.getState().busyOverlay).toBeNull();
    expect(timers.mock.calls.some(([, delay]) => delay === 900)).toBe(false);
  });

  it('SQLite 恢复拒绝重复坐标，不发布坏工作表', async () => {
    useData.getState().importMatrix('当前表', ['x'], [[10], [20]]);
    cancelPendingDatasetWork();
    const beforeModel = useData.getState().model;
    const corrupt = JSON.stringify(dataset('SQLite坏表', [
      { row: 0, col: 0 }, { row: 0, col: 0 },
    ]));
    const fake = observingDb(corrupt);
    platform.datasetDb = fake.db;
    localStorage.setItem('qp-active-ref-v1', 'SQLite坏表');

    await expect(hydrateActiveFromVault()).resolves.toBe(false);
    expect(useData.getState().model).toBe(beforeModel);
    expect(fake.get).toHaveBeenCalledWith('SQLite坏表');
    expect(fake.put).not.toHaveBeenCalled();
    expect(localStorage.getItem('qp-active-ref-v1')).toBeNull();
    expect(localStorage.getItem('qp-quarantine-v1')).toContain('pendingCells 包含重复坐标');
  });

  it('恰好覆盖全部矩阵坐标的合法边界被 helper、项目与运行时共同接受', () => {
    const pendingCells: PendingCell[] = [
      { row: 0, col: 0 }, { row: 0, col: 1 },
      { row: 1, col: 0 }, { row: 1, col: 1 },
    ];
    expect(worksheetPendingCellsError(pendingCells, { rows: 2, cols: 2 })).toBeNull();
    expect(projectStoreValidationError('qp-dataset-v1', {
      name: '全待录入项目',
      colNames: ['C1', 'C2'],
      rows: [[0, 0], [0, 0]],
      textCols: [],
      pendingCells,
      savedAt: '2026-08-13T00:00:00.000Z',
    })).toBeNull();

    expect(() => useData.getState().importMatrix(
      '全待录入运行时', ['C1', 'C2'], [[0, 0], [0, 0]], [], pendingCells,
    )).not.toThrow();
    expect(useData.getState().pendingCells).toEqual(pendingCells);
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).pendingCells).toEqual(pendingCells);
  });
});
