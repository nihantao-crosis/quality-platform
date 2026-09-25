/**
 * fix2609 第 1c 批 G2c-project 回归（M4 复审：P2 悬空卡不可见也删不掉；P3 隔离失败导出文案；
 * P3 侧栏无法辨认要删的卡；P3 导出多一次整库解析）。
 * 复审 R7：快照库损坏后再保存 6 条健康分析，悬空的旧卡被挤出侧栏（只渲染前 6 条），
 * 导出被「请在左侧删除」阻断，却在界面上找不到那两条卡。本批改为：
 * - 导出侧把悬空卡降级为「快照缺失」形态（去掉 sourceDataKey，加 sourceMissing:true），与
 *   PLATFORM-04 旧卡同口径，备份不再被阻断；
 * - v5 读取侧接受该标记（写读对称），store 侧保留标记，回看 fail-closed 提示「数据快照缺失」；
 * - useAnalyses.removeSnapshotMissing 一键删除全部快照缺失记录，侧栏已保存分析区给出入口。
 * 全部走真实生产函数（useData/useAnalyses/buildProjectJson(Full)/applyProjectJson/SideNav）。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  normalizeSavedAnalysesForStorage, reloadAnalyses, snapshotMissingAnalysisIds, useAnalyses, type SavedAnalysis,
} from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, settlePendingDatasetWrites, useData } from '../../store/dataStore';
import {
  applyProjectJson, buildProjectJson, buildProjectJsonFull, projectStoreValidationError,
} from '../../platform/project';
import { timestampTextOf } from '../../platform/reportLabels';
import { platform } from '../../platform/adapter';
import { SideNav } from '../shell/SideNav';

const LS_ANALYSES = 'qp-analyses-v1';
const LS_ANALYSIS_DATA = 'qp-analysis-data-v1';
const LS_QUARANTINE = 'qp-quarantine-v1';

function importAndSelect(name: string, rows: number[][]) {
  useData.getState().importMatrix(name, ['x'], rows);
  useApp.setState({ page: 'summary', activeVar: 'x' });
}

function saveSummaryOf(name: string, rows: number[][]): SavedAnalysis {
  importAndSelect(name, rows);
  const entry = useAnalyses.getState().saveCurrent();
  expect(entry).not.toBeNull();
  return entry!;
}

function exportedAnalyses(text: string): SavedAnalysis[] {
  const file = JSON.parse(text) as { stores: Record<string, string> };
  return JSON.parse(file.stores[LS_ANALYSES]) as SavedAnalysis[];
}

function projectText(stores: Record<string, string>) {
  return JSON.stringify({
    format: 'quality-platform-project', formatVersion: 5, appVersion: 'test', exportedAt: 't', stores,
  });
}

function card(id: string, snapshot: Record<string, unknown>) {
  return {
    id, kind: 'summary', title: `卡片${id}`, datasetName: '批次A.mtw', metric: 'm', status: '已完成',
    statusColor: '#2c8a45', statusBg: '#e8f4ea', createdAt: Date.UTC(2026, 6, 10, 8, 0, 0), snapshot,
  };
}

/** R7：两条旧卡引用的快照库被损坏 → 隔离后被新保存替换 → 再保存 6 条健康分析。 */
function arrangeR7() {
  const a = saveSummaryOf('批次A.csv', [[1], [2.5], [3.25], [4.75], [6]]);
  const b = saveSummaryOf('批次B.csv', [[11], [12.5], [13.25], [14.75], [16]]);
  localStorage.setItem(LS_ANALYSIS_DATA, '{"被截断');
  importAndSelect('批次C.csv', [[21], [22.5], [23.25], [24.75], [26]]);
  const healthy: SavedAnalysis[] = [];
  for (let i = 0; i < 6; i++) {
    const entry = useAnalyses.getState().saveCurrent();
    expect(entry).not.toBeNull();
    healthy.push(entry!);
  }
  const saved = useAnalyses.getState().saved;
  expect(saved.map((entry) => entry.id)).toEqual([...healthy.map((entry) => entry.id).reverse(), b.id, a.id]);
  // 悬空旧卡在库里已没有对应快照。
  const library = JSON.parse(localStorage.getItem(LS_ANALYSIS_DATA)!) as Record<string, unknown>;
  expect(Object.keys(library)).toEqual([healthy[0].snapshot.sourceDataKey]);
  return { a, b, healthy };
}

beforeEach(() => {
  platform.datasetDb = null;
  localStorage.clear();
  cancelPendingDatasetWork();
  useAnalyses.setState({ saved: [], lastError: null });
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({ page: 'dashboard', toast: null, activeVar: 'x' });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
});

describe('M4 P2：悬空卡降级为快照缺失形态，导出不再被阻断，再导入后可一键删除', () => {
  it('R7：快照库损坏后再保存 6 条健康分析，导出成功且悬空卡为快照缺失形态；再导入保留标记、回看 fail-closed、侧栏一键删除', async () => {
    const { a, b, healthy } = arrangeR7();

    // 本机悬空卡即被识别为快照缺失（侧栏只渲染前 6 条，它们本身不可见）。
    expect([...snapshotMissingAnalysisIds(useAnalyses.getState().saved)].sort()).toEqual([a.id, b.id].sort());

    const text = buildProjectJson('1.43.0');
    const exported = exportedAnalyses(text);
    const byId = new Map(exported.map((entry) => [entry.id, entry]));
    for (const dangling of [a, b]) {
      const snapshot = byId.get(dangling.id)!.snapshot as Record<string, unknown>;
      expect(snapshot.sourceDataKey).toBeUndefined();
      expect(snapshot.sourceData).toBeUndefined();
      expect(snapshot.sourceMissing).toBe(true);
    }
    for (const entry of healthy) {
      const snapshot = byId.get(entry.id)!.snapshot as Record<string, unknown>;
      expect(snapshot.sourceDataKey).toBe(healthy[0].snapshot.sourceDataKey);
      expect(snapshot.sourceMissing).toBeUndefined();
    }
    // 本机 live 记录不被导出改写。
    const live = JSON.parse(localStorage.getItem(LS_ANALYSES)!) as SavedAnalysis[];
    expect(live.find((entry) => entry.id === a.id)!.snapshot.sourceDataKey).toBe(a.snapshot.sourceDataKey);

    // 再导入：v5 读取侧接受标记形态，store 侧保留标记。
    localStorage.clear();
    expect(applyProjectJson(text)).toBeNull();
    reloadAnalyses();
    const restored = useAnalyses.getState().saved;
    expect(restored).toHaveLength(8);
    const missingA = restored.find((entry) => entry.id === a.id)!;
    expect(missingA.snapshot.sourceMissing).toBe(true);
    expect(missingA.snapshot.sourceDataKey).toBeUndefined();

    // 回看 fail-closed。
    {
      const worksheetBefore = useData.getState().model.name;
      expect(await useAnalyses.getState().restore(a.id)).toBe(false);
      expect(useApp.getState().toast ?? '').toContain('数据快照缺失');
      expect(useData.getState().model.name).toBe(worksheetBefore);

      // 侧栏：悬空卡不在前 6 条中，但入口给出数量并可一键删除（二次点击确认）。
      render(<SideNav />);
      const button = screen.getByRole('button', { name: /删除全部快照缺失记录/ });
      expect(screen.getByText(/2 条已保存分析的数据快照缺失/)).toBeTruthy();
      act(() => { fireEvent.click(button); });
      expect(useAnalyses.getState().saved).toHaveLength(8); // 首次点击只进入确认态
      act(() => { fireEvent.click(screen.getByRole('button', { name: /再次点击确认删除 2 条/ })); });
      expect(useAnalyses.getState().saved.map((entry) => entry.id))
        .toEqual(healthy.map((entry) => entry.id).reverse());
      expect(useApp.getState().toast ?? '').toContain('已删除 2 条快照缺失的分析记录');
      expect(screen.queryByRole('button', { name: /删除全部快照缺失记录/ })).toBeNull();

      const again = exportedAnalyses(buildProjectJson('1.43.0'));
      expect(again.some((entry) => (entry.snapshot as Record<string, unknown>).sourceMissing)).toBe(false);
    }
  });

  it('removeSnapshotMissing：本机悬空卡（未经导入）同样一次删除，健康卡与快照库不受影响', () => {
    const { a, b, healthy } = arrangeR7();
    const libraryBefore = localStorage.getItem(LS_ANALYSIS_DATA);
    expect(useAnalyses.getState().removeSnapshotMissing()).toBe(2);
    const ids = useAnalyses.getState().saved.map((entry) => entry.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).toHaveLength(healthy.length);
    expect(localStorage.getItem(LS_ANALYSIS_DATA)).toBe(libraryBefore);
    expect(useAnalyses.getState().removeSnapshotMissing()).toBe(0);
  });

  it('侧栏：可见的快照缺失卡带「快照缺失」徽标，悬停提示含保存时间（与导出文案同一口径）', () => {
    const a = saveSummaryOf('批次A.csv', [[1], [2.5], [3.25], [4.75], [6]]);
    localStorage.setItem(LS_ANALYSIS_DATA, JSON.stringify({}));
    render(<SideNav />);
    const row = screen.getAllByRole('button').find((button) => (button.getAttribute('title') ?? '').startsWith(a.title))!;
    expect(row).toBeTruthy();
    expect(row.getAttribute('title') ?? '').toContain(`保存于 ${timestampTextOf(a.createdAt)}`);
    expect(row.getAttribute('title') ?? '').toContain('数据快照缺失');
    expect(row.textContent).toContain('快照缺失');
  });
});

describe('M4 P2：v5 读取侧与 store 侧对快照缺失标记写读对称', () => {
  it('v5 文件：快照缺失标记形态被接受并原样保留；非法形态被拒', () => {
    const accepted = applyProjectJson(projectText({
      [LS_ANALYSES]: JSON.stringify([card('a1', { snapshotVersion: 7, sourceMissing: true })]),
    }));
    expect(accepted).toBeNull();
    const stored = JSON.parse(localStorage.getItem(LS_ANALYSES)!) as SavedAnalysis[];
    expect(stored[0].snapshot.sourceMissing).toBe(true);
    reloadAnalyses();
    expect(useAnalyses.getState().saved[0].snapshot.sourceMissing).toBe(true);

    const withKey = applyProjectJson(projectText({
      [LS_ANALYSES]: JSON.stringify([card('a1', { snapshotVersion: 7, sourceMissing: true, sourceDataKey: 'k' })]),
      [LS_ANALYSIS_DATA]: JSON.stringify({ k: { name: '批次A.mtw', colNames: ['x'], rows: [[1], [2]], textCols: [] } }),
    }));
    expect(withKey).toContain('快照缺失');
    const notTrue = applyProjectJson(projectText({
      [LS_ANALYSES]: JSON.stringify([card('a1', { snapshotVersion: 7, sourceMissing: false })]),
    }));
    expect(notTrue).toContain('sourceMissing');
  });

  it('store 启动校验与归一化保留标记', () => {
    const entry = card('a1', { snapshotVersion: 7, sourceMissing: true });
    expect(projectStoreValidationError(LS_ANALYSES, [entry])).toBeNull();
    expect(normalizeSavedAnalysesForStorage([entry])[0].snapshot.sourceMissing).toBe(true);
    expect(snapshotMissingAnalysisIds(normalizeSavedAnalysesForStorage([entry]))).toEqual(new Set(['a1']));
  });
});

describe('M4 P3：隔离失败（配额满）时导出文案给出卡片标签与可执行指引', () => {
  it('快照库隔离失败：钩子列出引用卡片并指引释放空间；释放后重试不再卡在钩子', async () => {
    const a = saveSummaryOf('批次A.csv', [[1], [2.5], [3.25], [4.75], [6]]);
    localStorage.setItem(LS_ANALYSIS_DATA, '{"被截断');
    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === LS_QUARANTINE) throw new DOMException('quota', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });
    const b = saveSummaryOf('批次B.csv', [[11], [12.5], [13.25], [14.75], [16]]);
    // 隔离失败 → 新卡只能内联保存，损坏库原文未被替换。
    expect(b.snapshot.sourceData).toBeDefined();
    expect(localStorage.getItem(LS_ANALYSIS_DATA)).toBe('{"被截断');

    const blocked = await buildProjectJsonFull('1.43.0').then(() => '', (error: Error) => error.message);
    expect(blocked).toContain('存储空间不足');
    expect(blocked).toContain('分析数据快照库');
    expect(blocked).toContain(`「${a.title}」（数据集 批次A.csv`);
    expect(blocked).toContain('释放');
    expect(blocked).toContain('项目未导出');

    spy.mockRestore();
    // 钩子重试隔离成功后，损坏原文已随隔离区附件带出：导出侧与读取侧同口径（fix2609j PLATFORM-05），
    // 按降级视图导出——快照库缺省、引用它的卡片标记为「快照缺失」，不再要求先保存一条新分析。
    const retried = JSON.parse(await buildProjectJsonFull('1.43.0')) as { stores: Record<string, string> };
    expect(retried.stores[LS_ANALYSIS_DATA]).toBeUndefined();
    const exportedA = (JSON.parse(retried.stores[LS_ANALYSES]) as Array<{ id: string; snapshot: Record<string, unknown> }>)
      .find((entry) => entry.id === a.id)!;
    expect(exportedA.snapshot.sourceMissing).toBe(true);
    expect(exportedA.snapshot.sourceDataKey).toBeUndefined();
    expect(JSON.parse(retried.stores[LS_QUARANTINE])[LS_ANALYSIS_DATA].raw).toBe('{"被截断');
    expect(JSON.parse(localStorage.getItem(LS_QUARANTINE)!)[LS_ANALYSIS_DATA].raw).toBe('{"被截断');
  });
});

describe('M4 P3：导出只对快照库做一次整库解析', () => {
  it('buildProjectJson 逐键校验的解析结果被悬空预检与孤儿裁剪复用', () => {
    saveSummaryOf('批次A.csv', [[1], [2.5], [3.25], [4.75], [6]]);
    const libraryRaw = localStorage.getItem(LS_ANALYSIS_DATA)!;
    const analysesRaw = localStorage.getItem(LS_ANALYSES)!;
    const parse = vi.spyOn(JSON, 'parse');
    buildProjectJson('1.43.0');
    // 逐键校验 1 次 + 末尾自导入校验 1 次（修复前悬空预检、孤儿裁剪各再解析一次：库 4 次、卡片 3 次）。
    expect(parse.mock.calls.filter(([arg]) => arg === libraryRaw)).toHaveLength(2);
    expect(parse.mock.calls.filter(([arg]) => arg === analysesRaw)).toHaveLength(2);
  });
});
