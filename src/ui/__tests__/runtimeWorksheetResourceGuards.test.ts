/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_IMPORT_DATA_COLS,
  MAX_IMPORT_DATA_ROWS,
  computeVarModel,
  worksheetResourceError,
  type VarModel,
} from '../../core';
import { platform, type DatasetDb } from '../../platform/adapter';
import { projectStoreValidationError } from '../../platform/project';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';
import { useApp } from '../../store/appStore';

function observingDb() {
  const put = vi.fn(async () => undefined);
  const db: DatasetDb = {
    put,
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => false),
    clear: vi.fn(async (opId: string) => ({ opId, committed: true as const, removed: 0 })),
    clearStatus: vi.fn(async () => null),
    stats: vi.fn(async () => ({ count: 0, total_bytes: 0, path: ':memory:' })),
  };
  return { db, put };
}

function logicalBoundaryModel(k: number, n: number, touched: ReturnType<typeof vi.fn>): VarModel {
  const base = useData.getState().model;
  const unreadableSubs = new Proxy([], {
    get(target, property, receiver) {
      if (property !== 'length') touched(`subs:${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  }) as VarModel['subs'];
  const unreadableNames = new Proxy(new Array<string>(n), {
    get(target, property, receiver) {
      if (property !== 'length') touched(`names:${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    ...base,
    name: `boundary-${k}x${n}`,
    isDemo: false,
    k,
    n,
    colNames: unreadableNames,
    subs: unreadableSubs,
  };
}

beforeEach(() => {
  cancelPendingDatasetWork();
  platform.datasetDb = null;
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [], undoStack: [], redoStack: [], pendingCells: [], textCols: [] });
  useApp.setState({ toast: null });
});

afterEach(() => {
  cancelPendingDatasetWork();
  platform.datasetDb = null;
  vi.restoreAllMocks();
});

describe('运行时结构编辑的统一资源闸门', () => {
  it('200000×1 再添加行会在访问/复制子组前原子拒绝', () => {
    const touched = vi.fn();
    const model = logicalBoundaryModel(MAX_IMPORT_DATA_ROWS, 1, touched);
    useData.setState({ model });
    localStorage.setItem('qp-dataset-v1', 'active-sentinel');
    localStorage.setItem('qp-recents-v1', 'recents-sentinel');
    const fake = observingDb();
    platform.datasetDb = fake.db;
    const before = useData.getState();

    const result = useData.getState().addSubgroupRow();

    const after = useData.getState();
    expect(after.model).toBe(before.model);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.redoStack).toBe(before.redoStack);
    expect(after.recents).toBe(before.recents);
    expect(result).toBe(false);
    expect(touched).not.toHaveBeenCalled();
    expect(localStorage.getItem('qp-dataset-v1')).toBe('active-sentinel');
    expect(localStorage.getItem('qp-recents-v1')).toBe('recents-sentinel');
    expect(fake.put).not.toHaveBeenCalled();
    expect(useApp.getState().toast).toContain('200,001');
  });

  it('2×5000 再插入列/公式列会在展开列名、行或求值前拒绝', () => {
    const touched = vi.fn();
    const model = logicalBoundaryModel(2, MAX_IMPORT_DATA_COLS, touched);
    useData.setState({ model });
    const before = useData.getState();

    const insertResult = useData.getState().insertColumn();
    const formulaResult = useData.getState().addFormulaColumn('new', 'C1 + 1');

    const after = useData.getState();
    expect(after.model).toBe(before.model);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.recents).toBe(before.recents);
    expect(insertResult).toBe(false);
    expect(touched).not.toHaveBeenCalled();
    expect(formulaResult).toContain('5,001');
  });

  it('applyEdit 在 pendingCells 重复时不推进撤销、活动表、最近项或持久化', () => {
    useData.getState().importMatrix('pending-guard', ['x'], [[1], [2]]);
    cancelPendingDatasetWork();
    useData.setState({ pendingCells: [{ row: 0, col: 0 }, { row: 0, col: 0 }] });
    const fake = observingDb();
    platform.datasetDb = fake.db;
    const before = useData.getState();
    const beforeActive = localStorage.getItem('qp-dataset-v1');
    const beforeRecents = localStorage.getItem('qp-recents-v1');

    useData.getState().renameColumn(0, 'renamed');

    const after = useData.getState();
    expect(after.model).toBe(before.model);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.redoStack).toBe(before.redoStack);
    expect(after.recents).toBe(before.recents);
    expect(after.pendingCells).toBe(before.pendingCells);
    expect(localStorage.getItem('qp-dataset-v1')).toBe(beforeActive);
    expect(localStorage.getItem('qp-recents-v1')).toBe(beforeRecents);
    expect(fake.put).not.toHaveBeenCalled();
    expect(useApp.getState().toast).toContain('重复坐标');
  });

  it('合法列边界仍可继续：2×4999 插入后恰为 5000 列', () => {
    const names = Array.from({ length: MAX_IMPORT_DATA_COLS - 1 }, (_, index) => `C${index + 1}`);
    const rows = [
      Array.from({ length: names.length }, (_, index) => index),
      Array.from({ length: names.length }, (_, index) => index + 1),
    ];
    useData.setState({
      model: computeVarModel('legal-column-edge', names, rows),
      textCols: [], pendingCells: [], recents: [], undoStack: [], redoStack: [],
    });

    const result = useData.getState().insertColumn();

    expect(result).toBe(true);
    expect(useData.getState().model.n).toBe(MAX_IMPORT_DATA_COLS);
    expect(useData.getState().pendingCells).toEqual([
      { row: 0, col: MAX_IMPORT_DATA_COLS - 1 },
      { row: 1, col: MAX_IMPORT_DATA_COLS - 1 },
    ]);
    expect(worksheetResourceError({ rows: MAX_IMPORT_DATA_ROWS, cols: 1 })).toBeNull();

    // 已到 5,000 列时，分析写回新增列也必须在扫描输出值前返回 false。
    const touched = vi.fn();
    const values = new Proxy([1, 2], {
      get(target, property, receiver) {
        if (property !== 'length') touched(String(property));
        return Reflect.get(target, property, receiver);
      },
    });
    const beforeWrite = useData.getState();
    expect(useData.getState().writeAnalysisColumns([{ name: 'new-analysis', values }])).toBe(false);
    expect(touched).not.toHaveBeenCalled();
    expect(useData.getState().model).toBe(beforeWrite.model);
    expect(useData.getState().undoStack).toBe(beforeWrite.undoStack);
  });
});

describe('QPROJ/运行时导入的 O(1) 维度前置闸门', () => {
  function unreadableArray(length: number, touched: ReturnType<typeof vi.fn>): unknown[] {
    return new Proxy(new Array(length), {
      get(target, property, receiver) {
        if (property !== 'length') touched(String(property));
        return Reflect.get(target, property, receiver);
      },
    });
  }

  it('200001×1 在 QPROJ 与 runtime 中均不读取任何行元素', () => {
    const projectTouched = vi.fn();
    const projectRows = unreadableArray(MAX_IMPORT_DATA_ROWS + 1, projectTouched);
    expect(projectStoreValidationError('qp-dataset-v1', {
      name: 'oversized-rows', colNames: ['x'], rows: projectRows, textCols: [], savedAt: 't',
    })).toContain('200,001');
    expect(projectTouched).not.toHaveBeenCalled();

    const runtimeTouched = vi.fn();
    const runtimeRows = unreadableArray(MAX_IMPORT_DATA_ROWS + 1, runtimeTouched) as number[][];
    const before = useData.getState().model;
    expect(() => useData.getState().importMatrix(
      'oversized-runtime', ['x'], runtimeRows,
    )).toThrow(/200,001/);
    expect(runtimeTouched).not.toHaveBeenCalled();
    expect(useData.getState().model).toBe(before);
  });

  it('超宽列在 QPROJ 与 runtime 中均不读取任何列名或矩阵元素', () => {
    const projectTouched = vi.fn();
    const projectNames = unreadableArray(MAX_IMPORT_DATA_COLS + 1, projectTouched);
    const projectRows = unreadableArray(2, projectTouched);
    expect(projectStoreValidationError('qp-dataset-v1', {
      name: 'oversized-columns', colNames: projectNames, rows: projectRows, textCols: [], savedAt: 't',
    })).toContain('5,001');
    expect(projectTouched).not.toHaveBeenCalled();

    const runtimeTouched = vi.fn();
    const runtimeNames = unreadableArray(MAX_IMPORT_DATA_COLS + 1, runtimeTouched) as string[];
    const runtimeRows = unreadableArray(2, runtimeTouched) as number[][];
    const before = useData.getState().model;
    expect(() => useData.getState().importMatrix(
      'oversized-runtime-columns', runtimeNames, runtimeRows,
    )).toThrow(/5,001/);
    expect(runtimeTouched).not.toHaveBeenCalled();
    expect(useData.getState().model).toBe(before);
  });
});
