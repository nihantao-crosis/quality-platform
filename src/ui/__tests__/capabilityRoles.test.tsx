/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { computeCapability, nf, prepareSpcData } from '../../core';
import { useAnalyses } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { rememberSpecFor, rememberSpecForActiveMeasurement, suggestedSpec, syncSpecForActiveMeasurement, useData } from '../../store/dataStore';
import { Capability } from '../pages/Capability';
import { Dashboard } from '../pages/Dashboard';
import { buildActiveAnalysisExport, buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { chartTokens } from '../tokens';
import App from '../../App';

const FEEDBACK_ROWS = [
  [1, 4.5, 10.1, 13.5, 11.0, 11.1],
  [2, 8.1, 10.7, 5.8, 3.1, 8.7],
  [3, 11.1, 4.7, 11.6, 3.8, 10.4],
];
const FEEDBACK_COLUMNS = ['子组', '直径1', '直径2', '直径3', '直径4', '直径5'];

function importFeedbackTable() {
  useData.getState().importMatrix('黄广洋样例.csv', FEEDBACK_COLUMNS, FEEDBACK_ROWS);
}

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useApp.setState({
    page: 'capability', spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null,
    spcStageCol: null, selSub: null, capabilityBins: 13,
    lsl: 24.9, tgt: 25, usl: 25.1, lslOn: true, uslOn: true,
  });
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [] });
});

describe('能力分析与 SPC 数据角色一致', () => {
  it('人工反馈表在能力页按 n=5 / N=15 分析，自动规格也排除数值子组 ID', () => {
    importFeedbackTable();
    const data = useData.getState();
    const prepared = prepareSpcData(data.model, data.textCols, {
      layout: 'auto', valueColumn: null, subgroupColumn: null,
    });
    if (!prepared.model) throw new Error(prepared.error);

    expect(prepared.model.n).toBe(5);
    expect(prepared.model.all).toHaveLength(15);
    const expectedSpec = suggestedSpec(prepared.model);
    const rawSpec = suggestedSpec(data.model);
    expect({ lsl: useApp.getState().lsl, tgt: useApp.getState().tgt, usl: useApp.getState().usl }).toEqual(expectedSpec);
    expect(expectedSpec).not.toEqual(rawSpec);

    const view = render(createElement(Capability, { T: chartTokens('经典', true) }));
    const text = view.container.textContent ?? '';
    expect(text).toContain('能力数据口径：按 3 个子组 × 5 次组内测量分析');
    expect(text).toContain('「子组」仅作子组标签，未参与测量计算');
    expect(text).toContain('实际观测 N=15');
    expect(text).not.toContain('实际观测 N=18');
  });

  it('角色有歧义时阻断能力分析，不回退到原始宽表混算', () => {
    useData.getState().importMatrix('歧义.csv', ['子组', '直径', '温度'], [
      [1, 10, 20], [1, 11, 21], [2, 12, 22], [2, 13, 23],
    ]);
    const view = render(createElement(Capability, { T: chartTokens('经典', true) }));
    const text = view.container.textContent ?? '';
    expect(text).toContain('过程能力分析未运行');
    expect(text).toContain('请选择哪一列是测量值');
    expect(text).toContain('不会把子组 ID 或其他数值字段静默混入计算');
  });

  it('歧义数据明确角色后，规格建议按所选测量值刷新，不沿用上一数据集', () => {
    useData.getState().importMatrix('歧义后配置.csv', ['子组', '直径', '温度'], [
      [1, 10, 100], [1, 12, 110], [2, 14, 120], [2, 16, 130],
    ]);
    const stale = { lsl: -999, tgt: -998, usl: -997 };
    useApp.setState({
      ...stale,
      spcDataLayout: 'stacked', spcValueCol: '直径', spcSubgroupCol: 'numeric:子组',
    });
    const data = useData.getState();
    const prepared = prepareSpcData(data.model, data.textCols, {
      layout: 'stacked', valueColumn: '直径', subgroupColumn: 'numeric:子组',
    });
    if (!prepared.model) throw new Error(prepared.error);
    const expected = suggestedSpec(prepared.model);

    // 真实入口在 SPC 角色确认时同步规格；能力页首次挂载不能覆盖历史规格。
    syncSpecForActiveMeasurement();
    const view = render(createElement(Capability, { T: chartTokens('经典', true) }));
    expect({ lsl: useApp.getState().lsl, tgt: useApp.getState().tgt, usl: useApp.getState().usl }).toEqual(expected);
    expect(expected).not.toEqual(stale);
    expect(view.container.textContent).toContain('实际观测 N=4');
  });

  it('角色在 SPC 中明确后立即同步全局规格，仪表盘无需先打开能力页', () => {
    useData.getState().importMatrix('仪表盘规格.csv', ['子组', '直径', '温度'], [
      [1, 10, 100], [1, 12, 110], [2, 14, 120], [2, 16, 130],
    ]);
    useApp.setState({
      lsl: -9, tgt: -8, usl: -7,
      spcDataLayout: 'stacked', spcValueCol: '直径', spcSubgroupCol: 'numeric:子组',
    });
    const prepared = prepareSpcData(useData.getState().model, useData.getState().textCols, {
      layout: 'stacked', valueColumn: '直径', subgroupColumn: 'numeric:子组',
    });
    if (!prepared.model) throw new Error(prepared.error);
    syncSpecForActiveMeasurement();
    expect({ lsl: useApp.getState().lsl, tgt: useApp.getState().tgt, usl: useApp.getState().usl })
      .toEqual(suggestedSpec(prepared.model));
  });

  it('同一工作表的不同测量特性分别记忆规格与单双侧状态', () => {
    useData.getState().importMatrix('压装.csv', ['过盈量', '压入力'], [
      [0.04, 900], [0.05, 1000], [0.06, 1100], [0.07, 1200],
    ]);
    useApp.setState({ spcDataLayout: 'individuals', spcValueCol: '压入力', lsl: 800, tgt: 1000, usl: 1300, lslOn: false, uslOn: true });
    rememberSpecForActiveMeasurement(useData.getState().model, useData.getState().textCols, {
      lsl: 800, tgt: 1000, usl: 1300, lslOn: false, uslOn: true,
    });

    useApp.setState({ spcValueCol: '过盈量' });
    syncSpecForActiveMeasurement();
    expect(useApp.getState().lslOn).toBe(true);
    expect(useApp.getState().uslOn).toBe(true);
    expect(useApp.getState().tgt).not.toBe(1000);

    useApp.setState({ spcValueCol: '压入力' });
    syncSpecForActiveMeasurement();
    expect(useApp.getState()).toMatchObject({ lsl: 800, tgt: 1000, usl: 1300, lslOn: false, uslOn: true });
  });

  it('同名文件重新导入不同内容不会继承旧内容的规格', () => {
    useData.getState().importMatrix('同名.csv', ['测量值'], [[1], [2], [3]]);
    rememberSpecForActiveMeasurement(useData.getState().model, [], {
      lsl: -100, tgt: 0, usl: 100, lslOn: false, uslOn: true,
    });

    useData.getState().importMatrix('同名.csv', ['测量值'], [[1000], [1100], [1200]]);
    expect(useApp.getState().tgt).toBe(1100);
    expect(useApp.getState().lslOn).toBe(true);
    expect(useApp.getState().uslOn).toBe(true);
  });

  it('保存的能力摘要与页面共用准备后模型，并快照恢复数据角色', () => {
    importFeedbackTable();
    const data = useData.getState();
    const prepared = prepareSpcData(data.model, data.textCols, {
      layout: 'auto', valueColumn: null, subgroupColumn: null,
    });
    if (!prepared.model) throw new Error(prepared.error);
    const app = useApp.getState();
    const expected = computeCapability(prepared.model.all, prepared.model.sigmaWithin, {
      lsl: app.lslOn ? app.lsl : null, tgt: app.tgt, usl: app.uslOn ? app.usl : null,
    });

    useApp.setState({ capabilityBins: 21 });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved?.metric).toBe(`Cpk ${nf(expected.cpk, 2)}`);
    expect(saved?.snapshot).toMatchObject({
      spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null,
      spcResolvedVariableName: '直径',
      capabilityBins: 21,
    });

    useApp.setState({ spcDataLayout: 'individuals', spcValueCol: '直径1', spcSubgroupCol: null, capabilityBins: 7 });
    useAnalyses.getState().restore(saved!.id);
    expect(useApp.getState()).toMatchObject({
      spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null,
      capabilityBins: 21,
    });
  });

  it('能力专项导出使用与页面相同的解析测量口径，不把子组 ID 混入', () => {
    importFeedbackTable();
    useApp.setState({ page: 'capability', capabilityBins: 17 });
    const report = buildActiveAnalysisReport();
    expect(report).toMatchObject({ kind: 'capability', usesWorksheet: true });
    expect(report?.subtitle).toContain('直径');
    expect(report?.subtitle).toContain('N=15');
    const source = report?.tables.find((table) => table.title.includes('解析子组'));
    expect(source?.headers).toEqual(['子组', '直径1', '直径2', '直径3', '直径4', '直径5']);
    expect(source?.rows).toHaveLength(3);
    expect(buildActiveAnalysisExport().model).toMatchObject({ n: 5, k: 3 });
    expect(report?.charts.find((chart) => chart.title === '过程能力直方图')?.svg).toContain('<svg');
  });

  it('能力历史回看保留保存时规格，不被当前数据集的规格记忆覆盖', async () => {
    importFeedbackTable();
    useApp.setState({ lsl: 0, tgt: 8, usl: 16, lslOn: true, uslOn: true });
    const before = buildActiveAnalysisReport();
    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved.snapshot).toMatchObject({ lsl: 0, tgt: 8, usl: 16 });

    rememberSpecFor('黄广洋样例.csv', { lsl: -100, tgt: 0, usl: 100 });
    useData.getState().importMatrix('后来数据.csv', ['测量1', '测量2'], [[100, 101], [102, 103], [104, 105]]);
    // 覆盖最危险的真实路径：能力页已经挂载，再从项目记录恢复另一数据集。
    render(createElement(Capability, { T: chartTokens('经典', true) }));
    await act(async () => { await useAnalyses.getState().restore(saved.id); });

    expect(useApp.getState()).toMatchObject({ lsl: 0, tgt: 8, usl: 16 });
    expect(buildActiveAnalysisReport()?.summary).toEqual(before?.summary);
  });

  it('反序规格在页面、保存摘要和专项报告统一阻断，规格输入仍可编辑修正', () => {
    importFeedbackTable();
    useApp.setState({ lsl: 20, tgt: 10, usl: 0, lslOn: true, uslOn: true });
    const text = render(createElement(Capability, { T: chartTokens('经典', true) })).container.textContent ?? '';
    expect(text).toContain('过程能力分析未运行');
    expect(text).toContain('LSL < USL');
    expect(text).toContain('规格限 (可编辑，实时重算)');
    expect(text).not.toContain('能力评估');
    expect(useAnalyses.getState().saveCurrent()).toMatchObject({ status: '未分析', metric: '双侧规格必须满足 LSL < USL' });
    const report = buildActiveAnalysisReport();
    expect(report?.summary.join(' ')).toContain('未运行');
    expect(report?.warnings.join(' ')).toContain('LSL < USL');
    expect(report?.charts).toHaveLength(0);
  });

  it('零方差真实过程不再显示无穷 Cpk 或能力充足', () => {
    useData.getState().importMatrix('常数过程.csv', ['测量1', '测量2'], [[10, 10], [10, 10], [10, 10]]);
    useApp.setState({ lsl: 9, tgt: 10, usl: 11, lslOn: true, uslOn: true });
    const text = render(createElement(Capability, { T: chartTokens('经典', true) })).container.textContent ?? '';
    expect(text).toContain('过程整体标准差为 0');
    expect(text).not.toContain('CpkInfinity');
    expect(text).not.toContain('能力充足');
    expect(useAnalyses.getState().saveCurrent()).toMatchObject({ status: '未分析' });
  });

  it('单侧规格在能力页、仪表盘、状态栏、保存与专项报告使用同一 Cpk', () => {
    importFeedbackTable();
    useApp.setState({ lsl: 12, tgt: 15, usl: 30, lslOn: false, uslOn: true, page: 'capability' });
    const data = useData.getState();
    const prepared = prepareSpcData(data.model, data.textCols, {
      layout: 'auto', valueColumn: null, subgroupColumn: null, pendingCells: data.pendingCells,
    });
    if (!prepared.model) throw new Error(prepared.error);
    const expected = computeCapability(prepared.model.all, prepared.model.sigmaWithin, { lsl: null, tgt: 15, usl: 30 });
    const expectedText = nf(expected.cpk, 2);

    const capability = render(createElement(Capability, { T: chartTokens('经典', true) }));
    expect(capability.container.textContent).toContain('单侧规格：Cpk = CPU');
    expect(useAnalyses.getState().saveCurrent()?.metric).toBe(`Cpk ${expectedText}`);
    expect(buildActiveAnalysisReport()?.summary.join(' ')).toContain(`Cpk=${nf(expected.cpk, 4)}`);
    cleanup();

    useApp.setState({ page: 'dashboard' });
    const dashboard = render(createElement(Dashboard, { T: chartTokens('经典', true) }));
    expect(dashboard.getByText('过程能力 Cpk').parentElement?.textContent).toContain(expectedText);
    cleanup();

    const app = render(createElement(App));
    const statusBar = app.getByText(`工作表: ${data.model.name}`, { exact: true }).parentElement;
    expect(statusBar?.textContent).toContain(`Cpk ${expectedText}`);
  });
});
