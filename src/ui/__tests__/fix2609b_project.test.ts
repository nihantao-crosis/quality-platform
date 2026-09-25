/**
 * fix2609 第 1b 批 G2b-project 回归（M4(b)；PLATFORM-04 残余 P3、GAP-4-12 残余 P3、STORE-01 残余 P3、holistic P2）：
 * 分析数据快照库被隔离（JSON 损坏/校验失败）或被新保存覆盖后，卡片引用的快照悬空——
 * 这正是「最需要备份时」。导出失败文案必须给出用户在「已保存分析」里能看到的卡片标题与
 * 可执行的处理办法，而不是只给内部去重键；删光引用后，残留的损坏库不能再永久阻断导出。
 * 全部走真实生产函数（useData/useAnalyses/buildProjectJson/applyProjectJson）。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAnalyses, type SavedAnalysis } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, settlePendingDatasetWrites, useData } from '../../store/dataStore';
import { applyProjectJson, buildProjectJson } from '../../platform/project';
import { platform } from '../../platform/adapter';

const LS_ANALYSES = 'qp-analyses-v1';
const LS_ANALYSIS_DATA = 'qp-analysis-data-v1';

function saveSummaryOf(name: string, rows: number[][]): SavedAnalysis {
  useData.getState().importMatrix(name, ['x'], rows);
  useApp.setState({ page: 'summary', activeVar: 'x' });
  const entry = useAnalyses.getState().saveCurrent();
  expect(entry).not.toBeNull();
  return entry!;
}

function exportError(): string {
  try {
    buildProjectJson('1.43.0');
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('导出本应失败');
}

function libraryKeys(): string[] {
  return Object.keys(JSON.parse(localStorage.getItem(LS_ANALYSIS_DATA) ?? '{}') as Record<string, unknown>);
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

const source = (name: string) => ({ name, colNames: ['x'], rows: [[3], [4], [5]], textCols: [] });

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
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
});

describe('M4(b) 分析快照库损坏/悬空引用：导出文案可定位、可操作，删光引用后可导出', () => {
  it('快照库 JSON 损坏：导出失败文案列出引用它的卡片标题并给出处理办法', () => {
    const a = saveSummaryOf('批次A.csv', [[1], [2.5], [3.25], [4.75], [6]]);
    const b = saveSummaryOf('批次B.csv', [[11], [12.5], [13.25], [14.75], [16]]);
    localStorage.setItem(LS_ANALYSIS_DATA, '{"被截断');
    const message = exportError();
    expect(message).toContain('qp-analysis-data-v1');
    expect(message).toContain('项目未导出');
    expect(message).toContain(`「${a.title}」（数据集 批次A.csv`);
    expect(message).toContain(`「${b.title}」（数据集 批次B.csv`);
    expect(message).toContain('2 条已保存分析');
    expect(message).toContain('保存一条新的工作表型分析即可替换损坏的快照库');
    expect(message).toContain('已保存分析');
  });

  it('快照库校验失败（非 JSON 损坏）同样给出卡片标题与处理办法', () => {
    const a = saveSummaryOf('批次A.csv', [[1], [2.5], [3.25], [4.75], [6]]);
    const key = a.snapshot.sourceDataKey!;
    const library = JSON.parse(localStorage.getItem(LS_ANALYSIS_DATA)!) as Record<string, { rows: unknown[] }>;
    library[key] = { ...library[key], rows: [[1, 2], [3]] };
    localStorage.setItem(LS_ANALYSIS_DATA, JSON.stringify(library));
    const message = exportError();
    expect(message).toContain('损坏');
    expect(message).toContain(`「${a.title}」（数据集 批次A.csv`);
    expect(message).toContain('保存一条新的工作表型分析即可替换损坏的快照库');
  });

  it('损坏库被新保存覆盖后，悬空引用文案给卡片标题与删除指引；按指引删除后可导出并再导入', () => {
    const a = saveSummaryOf('批次A.csv', [[1], [2.5], [3.25], [4.75], [6]]);
    const b = saveSummaryOf('批次B.csv', [[11], [12.5], [13.25], [14.75], [16]]);
    localStorage.setItem(LS_ANALYSIS_DATA, '{"被截断');
    const c = saveSummaryOf('批次C.csv', [[21], [22.5], [23.25], [24.75], [26]]);
    // 按上一条文案的指引：保存一条新分析后，库被替换为只含新快照。
    expect(libraryKeys()).toEqual([c.snapshot.sourceDataKey]);

    const message = exportError();
    expect(message).toContain(`「${a.title}」（数据集 批次A.csv`);
    expect(message).toContain(`「${b.title}」（数据集 批次B.csv`);
    expect(message).not.toContain('数据集 批次C.csv');
    expect(message).toContain('2 条已保存分析');
    expect(message).toContain('请在左侧「已保存分析」中删除');
    expect(message).toContain('项目未导出');

    expect(useAnalyses.getState().remove(a.id)).toBe(true);
    expect(useAnalyses.getState().remove(b.id)).toBe(true);
    const text = buildProjectJson('1.43.0');
    localStorage.clear();
    expect(applyProjectJson(text)).toBeNull();
    const restored = JSON.parse(localStorage.getItem(LS_ANALYSES)!) as SavedAnalysis[];
    expect(restored.map((entry) => entry.id)).toEqual([c.id]);
  });

  it('损坏库已无任何卡片引用时（删光引用记录）不再永久阻断导出', () => {
    const a = saveSummaryOf('批次A.csv', [[1], [2.5], [3.25], [4.75], [6]]);
    localStorage.setItem('qp-specs-v1', '{}');
    localStorage.setItem(LS_ANALYSIS_DATA, '{"被截断');
    expect(useAnalyses.getState().remove(a.id)).toBe(true);
    const text = buildProjectJson('1.43.0');
    const file = JSON.parse(text) as { stores: Record<string, string> };
    expect(file.stores[LS_ANALYSIS_DATA]).toBeUndefined();
    localStorage.clear();
    expect(applyProjectJson(text)).toBeNull();
  });

  it('导入侧：v5 文件悬空引用给出卡片标题；孤儿数据给出手工修改提示与重新导出指引', () => {
    const dangling = applyProjectJson(projectText({
      [LS_ANALYSES]: JSON.stringify([card('a1', { snapshotVersion: 7, sourceDataKey: 'k-missing' })]),
    }));
    expect(dangling).toContain('未包含在项目文件中');
    expect(dangling).toContain('「卡片a1」');
    expect(dangling).toContain('数据集 批次A.mtw');
    expect(dangling).toContain('重新导出');

    const orphan = applyProjectJson(projectText({
      [LS_ANALYSES]: JSON.stringify([card('a1', { snapshotVersion: 7, sourceDataKey: 'k-live' })]),
      [LS_ANALYSIS_DATA]: JSON.stringify({ 'k-live': source('批次A.mtw'), 'k-orphan': source('批次A.mtw') }),
    }));
    expect(orphan).toContain('没有对应的分析历史引用');
    expect(orphan).toContain('可能被手工修改');
    expect(orphan).toContain('重新导出');
  });
});
