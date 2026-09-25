/** QPROJ 属性图联合契约与 I-MR 独立序列资源闸门。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_INDIVIDUAL_SERIES_POINTS } from '../../core';
import { applyProjectJson, projectStoreValidationError } from '../../platform/project';
import { useAnalyses, type AnalysisSnapshot, type SavedAnalysis } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';

const projectText = (stores: Record<string, string>, vault?: Record<string, string>) => JSON.stringify({
  format: 'quality-platform-project',
  formatVersion: 4,
  appVersion: 'test',
  exportedAt: '2026-08-13T00:00:00.000Z',
  stores,
  ...(vault ? { vault } : {}),
});

const sourceData = (name = '工作表', indivSeries?: number[]) => ({
  name,
  colNames: ['x'],
  rows: [[1], [2]],
  textCols: [],
  ...(indivSeries ? { indivSeries } : {}),
});

const storedDataset = (name = '工作表', indivSeries?: number[]) => ({
  ...sourceData(name, indivSeries),
  savedAt: '2026-08-13T00:00:00.000Z',
});

const analysis = (id: string, snapshot: AnalysisSnapshot, kind: SavedAnalysis['kind'] = 'spc'): SavedAnalysis => ({
  id,
  kind,
  title: `分析 ${id}`,
  datasetName: '工作表',
  metric: '已计算',
  status: '已完成',
  statusColor: '#000',
  statusBg: '#fff',
  createdAt: 1,
  snapshot,
});

const pPayload = { name: '工作表', counts: [0, 1, 2], sampleSize: 10 };
const cPayload = { name: '工作表', counts: [1, 2, 3] };

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [], lastError: null });
  useApp.setState({ page: 'dashboard', spcType: 'xbar-r', toast: null });
});

describe('SPC 属性图 kind/type/payload 联合契约', () => {
  const invalidSnapshots: Array<[string, AnalysisSnapshot]> = [
    ['P 图异类 C 载荷', { snapshotVersion: 7, spcType: 'p', cChartData: cPayload }],
    ['P 图双载荷', {
      snapshotVersion: 7, spcType: 'p', pChartData: pPayload, cChartData: cPayload,
    }],
    ['P 图携带工作表', {
      snapshotVersion: 7, spcType: 'p', pChartData: pPayload, sourceData: sourceData(),
    }],
    ['P 图携带工作表键', {
      snapshotVersion: 7, spcType: 'p', pChartData: pPayload, sourceDataKey: 'd1',
    }],
    ['C 图异类 P 载荷', { snapshotVersion: 7, spcType: 'c', pChartData: pPayload }],
    ['C 图双载荷', {
      snapshotVersion: 7, spcType: 'c', pChartData: pPayload, cChartData: cPayload,
    }],
    ['C 图携带工作表', {
      snapshotVersion: 7, spcType: 'c', cChartData: cPayload, sourceData: sourceData(),
    }],
    ['非 P/C 携带 P 载荷', {
      snapshotVersion: 7, spcType: 'xbar-r', pChartData: pPayload,
    }],
    ['非 P/C 携带 C 载荷', {
      snapshotVersion: 7, spcType: 'i-mr', cChartData: cPayload,
    }],
    ['现代 P 图缺载荷', { snapshotVersion: 7, spcType: 'p' }],
    ['现代 C 图缺载荷', { snapshotVersion: 7, spcType: 'c' }],
  ];

  it('导入在任何 store 写入前拒绝异类、双载荷、额外 source 和现代缺载荷', () => {
    const marker = JSON.stringify({ name: '当前帕累托', rows: [{ name: '保留', count: 1 }] });
    localStorage.setItem('qp-pareto-v1', marker);

    for (const [label, snapshot] of invalidSnapshots) {
      const item = analysis(`bad-${label}`, snapshot);
      const detail = projectStoreValidationError('qp-analyses-v1', [item]);
      expect(detail, label).not.toBeNull();

      const error = applyProjectJson(projectText({ 'qp-analyses-v1': JSON.stringify([item]) }));
      expect(error, label).toContain('损坏');
      expect(localStorage.getItem('qp-pareto-v1'), label).toBe(marker);
      expect(localStorage.getItem('qp-analyses-v1'), label).toBeNull();
    }
  });

  it('只接受与 spcType 匹配的唯一载荷，无版本旧卡可读但仍由 restore 拒绝不精确回放', () => {
    expect(projectStoreValidationError('qp-analyses-v1', [
      analysis('p-ok', { snapshotVersion: 7, spcType: 'p', pChartData: pPayload }),
      analysis('c-ok', { snapshotVersion: 7, spcType: 'c', cChartData: cPayload }),
      analysis('legacy-p', { spcType: 'p' }),
    ])).toBeNull();
  });

  it('restore 在计数数组复制/导入和页面回放前再次 fail-closed', async () => {
    useData.getState().importCounts('p', '当前 P', [0, 1], 20);
    useData.getState().importCounts('c', '当前 C', [2, 3]);
    useData.setState({ mesRunning: true });
    useApp.setState({ page: 'capability', spcType: 'xbar-s', toast: null });
    const before = () => ({
      worksheet: useData.getState().model.name,
      p: { name: useData.getState().pModel.name, counts: [...useData.getState().pModel.pdef] },
      c: { name: useData.getState().cModel.name, counts: [...useData.getState().cModel.cdata] },
      mesRunning: useData.getState().mesRunning,
      page: useApp.getState().page,
      spcType: useApp.getState().spcType,
      attrStore: localStorage.getItem('qp-attr-v1'),
    });
    const expected = before();

    for (const [label, snapshot] of invalidSnapshots) {
      const item = analysis(`runtime-${label}`, snapshot);
      useAnalyses.setState({ saved: [item], lastError: null });
      await expect(useAnalyses.getState().restore(item.id), label).resolves.toBe(false);
      expect(before(), label).toEqual(expected);
    }
    useData.setState({ mesRunning: false });
  });
});

describe('QPROJ indivSeries 正式 I-MR 数量预算', () => {
  it('上限数量可用，且允许与 rows 展平值不同的合法独立序列', () => {
    const atLimit = new Array<number>(MAX_INDIVIDUAL_SERIES_POINTS).fill(1);
    expect(projectStoreValidationError('qp-dataset-v1', storedDataset('边界', atLimit))).toBeNull();
    expect(projectStoreValidationError('qp-dataset-v1', storedDataset('独立序列', [9, 7, 8, 6])))
      .toBeNull();
  });

  it('多 1 点时先看 length 拒绝，不遍历超限数组', () => {
    const backing = new Array<number>(MAX_INDIVIDUAL_SERIES_POINTS + 1).fill(1);
    const guarded = new Proxy(backing, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          throw new Error('超限 indivSeries 不应读取任何元素');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => projectStoreValidationError('qp-dataset-v1', storedDataset('先拒绝', guarded)))
      .not.toThrow();
    expect(projectStoreValidationError('qp-dataset-v1', storedDataset('先拒绝', guarded)))
      .toContain(MAX_INDIVIDUAL_SERIES_POINTS.toLocaleString());
  });

  it('active、recent、vault、内嵌/去重 analysis source 全部原子拒绝 +1', () => {
    const over = new Array<number>(MAX_INDIVIDUAL_SERIES_POINTS + 1).fill(1);
    const oversizedStored = storedDataset('超限', over);
    const oversizedSource = sourceData('超限', over);
    const summary = analysis(
      'summary-over',
      { snapshotVersion: 7, sourceData: oversizedSource },
      'summary',
    );
    const cases: Array<[string, string]> = [
      ['active', projectText({ 'qp-dataset-v1': JSON.stringify(oversizedStored) })],
      ['recent', projectText({
        'qp-recents-v1': JSON.stringify([{
          name: '超限', savedAt: oversizedStored.savedAt, data: oversizedStored,
        }]),
      })],
      ['analysis-inline', projectText({ 'qp-analyses-v1': JSON.stringify([summary]) })],
      ['analysis-library', projectText({
        'qp-analyses-v1': JSON.stringify([
          analysis('summary-key-over', { snapshotVersion: 7, sourceDataKey: 'd-over' }, 'summary'),
        ]),
        'qp-analysis-data-v1': JSON.stringify({ 'd-over': oversizedSource }),
      })],
      ['vault', projectText({ 'qp-specs-v1': '{}' }, { '超限': JSON.stringify(oversizedStored) })],
    ];
    const marker = JSON.stringify({ name: '当前帕累托', rows: [{ name: '保留', count: 1 }] });
    localStorage.setItem('qp-pareto-v1', marker);

    for (const [label, text] of cases) {
      const error = applyProjectJson(text);
      expect(error, label).toContain(MAX_INDIVIDUAL_SERIES_POINTS.toLocaleString());
      expect(localStorage.getItem('qp-pareto-v1'), label).toBe(marker);
      expect(localStorage.getItem('qp-dataset-v1'), label).toBeNull();
      expect(localStorage.getItem('qp-recents-v1'), label).toBeNull();
      expect(localStorage.getItem('qp-analyses-v1'), label).toBeNull();
      expect(localStorage.getItem('qp-analysis-data-v1'), label).toBeNull();
    }
  });
});
