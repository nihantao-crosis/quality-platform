/** QPROJ 非矩阵资源预算与产品写入口回归。 @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ATTRIBUTE_CHART_POINTS,
  MAX_FISHBONE_CATEGORY_CHARS,
  MAX_FISHBONE_CAUSE_CHARS,
  MAX_FISHBONE_CAUSES_PER_CATEGORY,
  MAX_FISHBONE_PROBLEM_CHARS,
  MAX_FISHBONE_TOTAL_CAUSES,
  MAX_IMPORT_CELL_CHARS,
  MAX_PARETO_CATEGORIES,
  MAX_SAVED_ANALYSES,
  MAX_ANALYSIS_DATA_ENTRIES,
  MAX_ANALYSIS_DATA_KEY_CHARS,
  MAX_ANALYSIS_ID_CHARS,
} from '../../core';
import { platform } from '../../platform/adapter';
import {
  applyProjectJson,
  buildProjectJson,
  projectStoreValidationError,
} from '../../platform/project';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import {
  clearFishboneState,
  FISHBONE_STORAGE_KEY,
  saveFishboneState,
  type FishboneData,
} from '../../store/fishboneStore';
import { Fishbone } from '../pages/Fishbone';
import { Modals } from '../shell/Modals';
import { chartTokens } from '../tokens';

const projectText = (stores: Record<string, string>) => JSON.stringify({
  format: 'quality-platform-project',
  formatVersion: 4,
  appVersion: 'test',
  exportedAt: '2026-08-12T00:00:00.000Z',
  stores,
});

const fishbone = (causeCounts: number[] = [0, 0, 0, 0, 0, 0]): FishboneData => ({
  problem: '问题',
  categories: causeCounts.map((count, index) => ({
    name: `分类${index + 1}`,
    causes: Array.from({ length: count }, (_, causeIndex) => `原因${index + 1}-${causeIndex + 1}`),
  })),
});

const analysisSource = (name = '历史数据') => ({
  name, colNames: ['x'], rows: [[1], [2]], textCols: [],
});

const savedAnalysis = (id: string, sourceDataKey?: string) => ({
  id, kind: 'summary', title: `摘要 ${id}`, datasetName: '历史数据', metric: 'N=2', status: '已完成',
  statusColor: '#000', statusBg: '#fff', createdAt: 1,
  snapshot: { snapshotVersion: 7, ...(sourceDataKey ? { sourceDataKey } : { sourceData: analysisSource() }) },
});

beforeEach(() => {
  localStorage.clear();
  clearFishboneState();
  useData.getState().resetDemo();
  useApp.setState({ modal: null, busyOverlay: null, toast: null, importTab: 'csv', importKind: 'var' });
});

afterEach(() => vi.restoreAllMocks());

describe('P/C 计数图序列资源上限', () => {
  it('项目校验接受上限边界，拒绝多 1 点的活动 store 和分析快照', () => {
    const atLimit = Array<number>(MAX_ATTRIBUTE_CHART_POINTS).fill(0);
    expect(projectStoreValidationError('qp-attr-v1', {
      p: { name: 'P', counts: atLimit, sampleSize: 1 },
      c: { name: 'C', counts: atLimit },
    })).toBeNull();

    const overLimit = Array<number>(MAX_ATTRIBUTE_CHART_POINTS + 1).fill(0);
    expect(projectStoreValidationError('qp-attr-v1', {
      p: { name: 'P', counts: overLimit, sampleSize: 1 },
    })).toContain(`${MAX_ATTRIBUTE_CHART_POINTS.toLocaleString()}`);
    expect(projectStoreValidationError('qp-attr-v1', {
      c: { name: 'C', counts: overLimit },
    })).toContain(`${MAX_ATTRIBUTE_CHART_POINTS.toLocaleString()}`);

    const analysisBase = {
      id: 'a1', kind: 'spc', title: 'SPC', datasetName: 'd', metric: 'm', status: 's',
      statusColor: '#000', statusBg: '#fff', createdAt: 1,
    };
    expect(projectStoreValidationError('qp-analyses-v1', [{
      ...analysisBase,
      snapshot: { snapshotVersion: 7, spcType: 'p', pChartData: { name: 'P', counts: overLimit, sampleSize: 1 } },
    }])).toContain('分析 P 图快照');
    expect(projectStoreValidationError('qp-analyses-v1', [{
      ...analysisBase,
      snapshot: { snapshotVersion: 7, spcType: 'c', cChartData: { name: 'C', counts: overLimit } },
    }])).toContain('分析 C 图快照');
  });

  it('实时写入在计算和 state/localStorage 副作用前拒绝超限序列', () => {
    useData.getState().importCounts('p', '原 P', [0, 1], 2);
    useData.getState().importCounts('c', '原 C', [1, 2]);
    const beforeP = useData.getState().pModel;
    const beforeC = useData.getState().cModel;
    const beforeStorage = localStorage.getItem('qp-attr-v1');
    const overLimit = Array<number>(MAX_ATTRIBUTE_CHART_POINTS + 1).fill(0);
    useData.getState().setMesRunning(true);

    expect(() => useData.getState().importCounts('p', '攻击 P', overLimit, 1))
      .toThrow(`${MAX_ATTRIBUTE_CHART_POINTS.toLocaleString()}`);
    expect(() => useData.getState().importCounts('c', '攻击 C', overLimit))
      .toThrow(`${MAX_ATTRIBUTE_CHART_POINTS.toLocaleString()}`);
    expect(useData.getState().pModel).toBe(beforeP);
    expect(useData.getState().cModel).toBe(beforeC);
    expect(useData.getState().mesRunning).toBe(true);
    expect(localStorage.getItem('qp-attr-v1')).toBe(beforeStorage);
    useData.getState().setMesRunning(false);
  });
});

describe('鱼骨图数量与文本预算', () => {
  it('每类/总数边界可用，各自多 1 条即拒绝', () => {
    const perCategoryLimit = fishbone([MAX_FISHBONE_CAUSES_PER_CATEGORY, 0, 0, 0, 0, 0]);
    expect(projectStoreValidationError(FISHBONE_STORAGE_KEY, perCategoryLimit)).toBeNull();

    const totalLimit = fishbone([200, 200, 200, 200, 200, 0]);
    expect(totalLimit.categories.reduce((sum, category) => sum + category.causes.length, 0))
      .toBe(MAX_FISHBONE_TOTAL_CAUSES);
    expect(projectStoreValidationError(FISHBONE_STORAGE_KEY, totalLimit)).toBeNull();
    expect(projectStoreValidationError(
      FISHBONE_STORAGE_KEY,
      fishbone([MAX_FISHBONE_CAUSES_PER_CATEGORY + 1, 0, 0, 0, 0, 0]),
    )).toContain('单个分类原因数');
    expect(projectStoreValidationError(FISHBONE_STORAGE_KEY, fishbone([200, 200, 200, 200, 200, 1])))
      .toContain('原因总数');
  });

  it('problem/category/cause 字符上限均有正反边界', () => {
    const atLimit = fishbone([1, 0, 0, 0, 0, 0]);
    atLimit.problem = 'p'.repeat(MAX_FISHBONE_PROBLEM_CHARS);
    atLimit.categories[0].name = 'c'.repeat(MAX_FISHBONE_CATEGORY_CHARS);
    atLimit.categories[0].causes[0] = 'x'.repeat(MAX_FISHBONE_CAUSE_CHARS);
    expect(projectStoreValidationError(FISHBONE_STORAGE_KEY, atLimit)).toBeNull();

    expect(projectStoreValidationError(FISHBONE_STORAGE_KEY, {
      ...atLimit, problem: 'p'.repeat(MAX_FISHBONE_PROBLEM_CHARS + 1),
    })).toContain('问题');
    expect(projectStoreValidationError(FISHBONE_STORAGE_KEY, {
      ...atLimit,
      categories: atLimit.categories.map((category, index) => index === 0
        ? { ...category, name: 'c'.repeat(MAX_FISHBONE_CATEGORY_CHARS + 1) }
        : category),
    })).toContain('分类名称');
    expect(projectStoreValidationError(FISHBONE_STORAGE_KEY, {
      ...atLimit,
      categories: atLimit.categories.map((category, index) => index === 0
        ? { ...category, causes: ['x'.repeat(MAX_FISHBONE_CAUSE_CHARS + 1)] }
        : category),
    })).toContain('单条原因');
  });

  it('实时持久化拒绝超限且不覆盖旧值，导出不会静默截断', () => {
    const valid = fishbone([200, 200, 200, 200, 200, 0]);
    valid.problem = 'p'.repeat(MAX_FISHBONE_PROBLEM_CHARS);
    valid.categories[0].name = 'c'.repeat(MAX_FISHBONE_CATEGORY_CHARS);
    valid.categories[0].causes[0] = 'x'.repeat(MAX_FISHBONE_CAUSE_CHARS);
    saveFishboneState(valid, false);
    const before = localStorage.getItem(FISHBONE_STORAGE_KEY);
    const exported = JSON.parse(buildProjectJson('test')) as { stores: Record<string, string> };
    expect(JSON.parse(exported.stores[FISHBONE_STORAGE_KEY])).toEqual({ data: valid, isDemo: false });
    const oversized = { ...valid, problem: 'p'.repeat(MAX_FISHBONE_PROBLEM_CHARS + 1) };
    expect(() => saveFishboneState(oversized, false)).toThrow('问题');
    expect(localStorage.getItem(FISHBONE_STORAGE_KEY)).toBe(before);

    // 手工/旧版污染的超限 store 必须阻断备份，不能裁掉字符后生成看似成功的 QPROJ。
    localStorage.setItem(FISHBONE_STORAGE_KEY, JSON.stringify(oversized));
    expect(() => buildProjectJson('test')).toThrow('鱼骨图问题');
    expect(JSON.parse(localStorage.getItem(FISHBONE_STORAGE_KEY)!).problem)
      .toHaveLength(MAX_FISHBONE_PROBLEM_CHARS + 1);
  });

  it('编辑页在达到上限时保留已保存内容并显示具体拒绝原因', () => {
    const valid = fishbone();
    valid.problem = 'p'.repeat(MAX_FISHBONE_PROBLEM_CHARS);
    saveFishboneState(valid, false);
    render(<Fishbone T={chartTokens('经典', true)} />);

    fireEvent.change(screen.getByPlaceholderText('待分析的质量问题'), {
      target: { value: valid.problem + 'x' },
    });
    expect(useApp.getState().toast).toContain(`${MAX_FISHBONE_PROBLEM_CHARS} 字符上限`);
    expect(JSON.parse(localStorage.getItem(FISHBONE_STORAGE_KEY)!).data.problem).toBe(valid.problem);
  });
});

describe('帕累托实时写入与 QPROJ 失败原子性', () => {
  it('帕累托上限边界可导入，类别数/数据集名/类别名多 1 均在写入前拒绝', () => {
    const exact = Array.from({ length: MAX_PARETO_CATEGORIES }, (_, index) => ({ name: `C${index}`, count: 1 }));
    const accepted = useData.getState().importPareto('边界帕累托', exact);
    expect(accepted.rejected).toBeUndefined();
    const before = useData.getState().paretoModel;
    const beforeStorage = localStorage.getItem('qp-pareto-v1');
    useData.getState().setMesRunning(true);

    expect(useData.getState().importPareto('过多', [...exact, { name: '多一类', count: 1 }]).rejected)
      .toContain(`${MAX_PARETO_CATEGORIES.toLocaleString()}`);
    expect(useData.getState().importPareto('n'.repeat(MAX_IMPORT_CELL_CHARS + 1), [{ name: 'A', count: 1 }]).rejected)
      .toContain(`${MAX_IMPORT_CELL_CHARS.toLocaleString()}`);
    expect(useData.getState().importPareto('过长类别', [{ name: 'x'.repeat(MAX_IMPORT_CELL_CHARS + 1), count: 1 }]).rejected)
      .toContain(`${MAX_IMPORT_CELL_CHARS.toLocaleString()}`);
    expect(useData.getState().paretoModel).toBe(before);
    expect(useData.getState().mesRunning).toBe(true);
    expect(localStorage.getItem('qp-pareto-v1')).toBe(beforeStorage);
    useData.getState().setMesRunning(false);
  });

  it('超限 QPROJ 在任何 store 写入与重载调度前失败', async () => {
    const current = JSON.stringify({ name: '当前', rows: [{ name: '保留', count: 1 }] });
    localStorage.setItem('qp-pareto-v1', current);
    const attack = projectText({
      'qp-pareto-v1': JSON.stringify({ name: '外来', rows: [{ name: '攻击', count: 9 }] }),
      'qp-attr-v1': JSON.stringify({
        c: { name: '超限 C', counts: Array<number>(MAX_ATTRIBUTE_CHART_POINTS + 1).fill(0) },
      }),
    });

    expect(applyProjectJson(attack)).toContain('资源上限');
    expect(localStorage.getItem('qp-pareto-v1')).toBe(current);

    vi.spyOn(platform, 'pickImportFile').mockResolvedValue({ name: 'attack.qproj', contents: attack });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    useApp.setState({ modal: 'import', busyOverlay: null, toast: null });
    render(<Modals />);
    timers.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await waitFor(() => expect(useApp.getState().toast).toContain('资源上限'));
    expect(useApp.getState().busyOverlay).toBeNull();
    expect(localStorage.getItem('qp-pareto-v1')).toBe(current);
    expect(timers.mock.calls.some(([, delay]) => delay === 900)).toBe(false);
  });
});

describe('分析历史与去重工作表资源边界', () => {
  it('历史只接受最多 40 个唯一非空 ID，数据仓库条目和 key 使用同一预算', () => {
    const exact = Array.from({ length: MAX_SAVED_ANALYSES }, (_, index) => savedAnalysis(`a${index}`));
    expect(projectStoreValidationError('qp-analyses-v1', exact)).toBeNull();
    expect(projectStoreValidationError('qp-analyses-v1', [...exact, savedAnalysis('extra')]))
      .toContain(`${MAX_SAVED_ANALYSES}`);
    expect(projectStoreValidationError('qp-analyses-v1', [savedAnalysis('same'), savedAnalysis('same')]))
      .toContain('重复 id');
    expect(projectStoreValidationError('qp-analyses-v1', [savedAnalysis('')])).toContain('必须非空');
    expect(projectStoreValidationError('qp-analyses-v1', [savedAnalysis('x'.repeat(MAX_ANALYSIS_ID_CHARS + 1))]))
      .toContain(`${MAX_ANALYSIS_ID_CHARS}`);

    const library = Object.fromEntries(Array.from(
      { length: MAX_ANALYSIS_DATA_ENTRIES },
      (_, index) => [`d${index}`, analysisSource(`历史${index}`)],
    ));
    expect(projectStoreValidationError('qp-analysis-data-v1', library)).toBeNull();
    expect(projectStoreValidationError('qp-analysis-data-v1', { ...library, extra: analysisSource('多一份') }))
      .toContain(`${MAX_ANALYSIS_DATA_ENTRIES}`);
    expect(projectStoreValidationError('qp-analysis-data-v1', {
      ['k'.repeat(MAX_ANALYSIS_DATA_KEY_CHARS + 1)]: analysisSource(),
    })).toContain(`${MAX_ANALYSIS_DATA_KEY_CHARS}`);
  });

  it('重复 ID 或孤儿工作表的 QPROJ 在写入前原子拒绝，精确引用可导入', () => {
    const marker = JSON.stringify({ name: '当前', rows: [{ name: '保留', count: 1 }] });
    localStorage.setItem('qp-pareto-v1', marker);
    const duplicate = projectText({
      'qp-analyses-v1': JSON.stringify([savedAnalysis('same'), savedAnalysis('same')]),
    });
    expect(applyProjectJson(duplicate)).toContain('重复 id');
    expect(localStorage.getItem('qp-pareto-v1')).toBe(marker);

    const orphan = projectText({
      'qp-analyses-v1': JSON.stringify([savedAnalysis('a1')]),
      'qp-analysis-data-v1': JSON.stringify({ orphan: analysisSource('孤儿') }),
    });
    expect(applyProjectJson(orphan)).toContain('没有对应的分析历史引用');
    expect(localStorage.getItem('qp-pareto-v1')).toBe(marker);

    const exact = projectText({
      'qp-analyses-v1': JSON.stringify([savedAnalysis('a1', 'd1')]),
      'qp-analysis-data-v1': JSON.stringify({ d1: analysisSource('历史数据') }),
    });
    expect(applyProjectJson(exact)).toBeNull();
    expect(JSON.parse(localStorage.getItem('qp-analyses-v1')!)).toHaveLength(1);
    expect(Object.keys(JSON.parse(localStorage.getItem('qp-analysis-data-v1')!))).toEqual(['d1']);
  });
});
