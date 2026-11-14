/** @vitest-environment jsdom */
/**
 * 2026-09 全面审查第 3 批 · G9-spcpipeline(消费者一致性)
 * 同一份数据、同一 SPC 配置下:SPC 页 / 质量总览 / 能力页 / 保存记录 / 专项与通用报告
 * 的稳定性结论必须一致，或在有意不同(能力不分阶段、按子组图)时写明口径。
 * 全部走真实页面渲染、真实 store 与真实报告构建器。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Spc, computeSpcPageView } from '../pages/Spc';
import { Dashboard } from '../pages/Dashboard';
import { Capability } from '../pages/Capability';
import { chartTokens } from '../tokens';
import { assessSpcCharts, DEFAULT_RULE_K, prepareSpcData } from '../../core';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { buildActiveAnalysisExport, buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';

const RULES = { r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false };
const RULE1 = { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
const T = chartTokens('经典', true);

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useAnalyses.setState({ saved: [], lastError: null });
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({
    page: 'spc', modal: null, spcType: 'xbar-r', spcRules: { ...RULES }, spcRuleK: { ...DEFAULT_RULE_K },
    spcDataLayout: 'rows', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    spcSigmaMethod: 'classic', spcShowZones: true, selSub: null,
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    capabilityWarningAcknowledgement: null,
  });
});

/** CORE-09 reproObservation 同构：20 子组 × n=5，改进前均值≈10.0 / 改进后≈10.5，段内平稳。 */
function importStepData(extraText: Array<{ name: string; values: string[] }> = []) {
  const rows = Array.from({ length: 20 }, (_, i) => {
    const x = (i < 10 ? 10 : 10.5) + 0.02 * (((i * 7) % 5) - 2);
    const s = 0.1 + 0.02 * ((i * 3) % 4);
    return [x - 2 * s, x - s, x, x + s, x + 2 * s];
  });
  useData.getState().importMatrix('改进前后.csv', ['x1', 'x2', 'x3', 'x4', 'x5'], rows, [
    { name: '阶段', values: rows.map((_, i) => (i < 10 ? '改进前' : '改进后')) },
    ...extraText,
  ]);
  useApp.setState({ lsl: 9, tgt: 10.25, usl: 11.5, lslOn: true, uslOn: true });
}

function pageView() {
  const app = useApp.getState();
  const data = useData.getState();
  const prepared = prepareSpcData(data.model, data.textCols, {
    layout: app.spcDataLayout, valueColumn: app.spcValueCol, subgroupColumn: app.spcSubgroupCol, pendingCells: data.pendingCells,
  });
  return computeSpcPageView({
    prepared, rawModel: data.model, spcType: app.spcType, spcSigmaMethod: app.spcSigmaMethod, spcStageCol: app.spcStageCol,
    spcRules: app.spcRules, spcRuleK: app.spcRuleK, spcShowZones: app.spcShowZones, pModel: data.pModel, cModel: data.cModel,
  });
}

function saveOn(page: 'spc' | 'capability') {
  useApp.setState({ page });
  return useAnalyses.getState().saveCurrent()!;
}

describe('CORE-09 分阶段:所有消费者同一结论或明示口径', () => {
  it('SPC 页 / 质量总览 / SPC 记录 / SPC 专项报告 / 通用报告评估器的失控计数一致', () => {
    importStepData();
    useApp.setState({ spcStageCol: '阶段' });

    // [A] SPC 页：段内判异 0 失控
    const view = pageView();
    expect(view.staged?.x.segments).toHaveLength(2);
    expect(view.violations.affectedPointCount).toBe(0);

    // [B] 质量总览：SPC 告警与趋势图改用同一段内口径(修复前：44 条告警 + 20 个全局红点)
    useApp.setState({ page: 'dashboard' });
    const dash = render(createElement(Dashboard, { T })).container.textContent ?? '';
    expect(dash).toContain('过程受控(分阶段 2 段)');
    expect(dash).toContain('X̄-R · 分阶段 2 段');
    expect(dash).not.toMatch(/X̄ 图子组 \d+ 违反准则/);
    // Cpk 卡保留能力口径(全局)，但必须写明
    expect(dash).toContain('控制图 20 个失控点');
    expect(dash).toContain('稳定性按 X̄-R 图·全局限（未分阶段）');
    cleanup();

    // [C] 保存的 SPC 记录与专项报告
    const spcRecord = saveOn('spc');
    expect(spcRecord).toMatchObject({ title: 'X̄-R 控制图 · 分阶段', metric: '2 阶段 · 过程受控', status: '受控' });
    const report = buildActiveAnalysisReport()!;
    expect(report.summary[0]).not.toMatch(/失控点/);

    // [D] 通用报告：导出上下文携带阶段口径，唯一评估器给出与页面相同的计数与分阶段说明
    useApp.setState({ page: 'dashboard' });
    const exported = buildActiveAnalysisExport();
    expect(exported.spcStage).toMatchObject({ state: 'active', column: '阶段' });
    const app = useApp.getState();
    const assessment = assessSpcCharts(exported.model, app.spcRules, app.spcRuleK, exported.spcFamily, exported.spcStage);
    expect(assessment.uniqueAnalysisUnitCount).toBe(view.violations.affectedPointCount);
    expect(assessment.verdictLine).toContain('分阶段：按「阶段」2 段段内控制限判异');
  });

  it('能力页 / 能力记录 / 能力专项报告有意按全局限值评估，并在文案中明写「未分阶段」', () => {
    importStepData();
    useApp.setState({ spcStageCol: '阶段', page: 'capability' });
    const cap = render(createElement(Capability, { T })).container.textContent ?? '';
    expect(cap).toContain('稳定性口径：稳定性按 X̄-R 图、全局控制限（未分阶段）评估；能力分析不分阶段，与 SPC 页分阶段结论口径不同');
    expect(cap).toContain('本页失控点 20 个按此口径计数');
    cleanup();

    const record = saveOn('capability');
    expect(record.metric).toContain('稳定性按 X̄-R 图·全局限（未分阶段）');
    expect(record.status).toContain('过程不稳定');
    const report = buildActiveAnalysisReport()!;
    expect(report.warnings.join(' ')).toContain('全局控制限（未分阶段）');

    // 未选阶段列时不添加口径噪声
    useApp.setState({ spcStageCol: null });
    expect(saveOn('capability').metric).not.toContain('稳定性按');
  });
});

describe('UI-12 子组数据 + I-MR：总览跟随 SPC 页图型，能力侧注明图型', () => {
  function importImrData() {
    const rows = Array.from({ length: 20 }, () => [10, 10, 10, 10, 10, 10, 10, 10, 10, 13]);
    useData.getState().importMatrix('子组IMR.csv', rows[0].map((_, j) => `m${j + 1}`), rows, []);
    useApp.setState({ spcType: 'i-mr', spcRules: { ...RULE1 }, lsl: 5, tgt: 10.5, usl: 16, lslOn: true, uslOn: true });
  }

  it('质量总览 SPC 告警按 I-MR 判异(与 SPC 页一致)，不再固定按 X̄-R 显示「过程受控」', () => {
    importImrData();
    const view = pageView();
    expect(view.effType).toBe('i-mr');
    expect(view.violations.affectedPointCount).toBeGreaterThan(0);
    expect(view.violations.variation.affectedPointCount).toBeGreaterThan(0);

    useApp.setState({ page: 'dashboard' });
    const dash = render(createElement(Dashboard, { T })).container.textContent ?? '';
    expect(dash).toContain('过程单值趋势');
    expect(dash).toContain('I-MR · 200 观测');
    expect(dash).not.toContain('过程受控');
    // 页面先判 MR 图；总览同样离散图优先告警
    expect(dash).toMatch(/MR 图点 \d+ 违反准则 1/);
    // Cpk 卡按能力口径(X̄-R，0 失控)，写明图型
    expect(dash).toContain('稳定性按 X̄-R 图');
  });

  it('能力页与能力记录写明「稳定性按 X̄-R 图评估；与 SPC 页当前 I-MR 视图口径不同」', () => {
    importImrData();
    useApp.setState({ page: 'capability' });
    const cap = render(createElement(Capability, { T })).container.textContent ?? '';
    expect(cap).toContain('稳定性按 X̄-R 图评估；与 SPC 页当前 I-MR 视图口径不同');
    cleanup();
    expect(saveOn('capability').metric).toContain('稳定性按 X̄-R 图');
    expect(buildActiveAnalysisReport()!.warnings.join(' ')).toContain('与 SPC 页当前 I-MR 视图口径不同');
  });
});

describe('PLATFORM-21 阶段校验失败：页面/看板/记录/报告统一拒绝并明示原因', () => {
  const SINGLE = [{ name: '班次', values: Array(20).fill('早班') }];

  it('阶段列只有 1 个连续段：SPC 页不再显示按全局限值退化出的结论', () => {
    importStepData(SINGLE);
    useApp.setState({ spcStageCol: '班次' });
    const view = render(createElement(Spc, { T }));
    const text = view.container.textContent ?? '';
    expect(text).toContain('X̄-R 分阶段未运行，未生成统计结论：阶段列只有 1 个连续段');
    expect(text).toContain('阶段未启用：阶段列只有 1 个连续段');
    // 修复前：页面照常显示 UCL/失控点/「检验结果」
    expect(text).not.toContain('检验结果');
    expect(text).not.toMatch(/\d+ 个失控点/);
    expect(view.container.querySelectorAll('svg').length).toBe(0);

    expect(saveOn('spc')).toMatchObject({ title: 'X̄-R 控制图 · 分阶段未运行', status: '未分析', metric: '阶段列只有 1 个连续段' });
    const report = buildActiveAnalysisReport()!;
    expect(report.title).toContain('分阶段未运行');
    expect(report.charts).toHaveLength(0);

    useApp.setState({ page: 'dashboard' });
    cleanup();
    const dash = render(createElement(Dashboard, { T })).container.textContent ?? '';
    expect(dash).toContain('X̄-R 分阶段未运行：阶段列只有 1 个连续段');
    expect(dash).toContain('SPC 分阶段未运行');
    expect(dash).not.toMatch(/X̄ 图子组 \d+ 违反准则/);
    expect(() => buildActiveAnalysisExport()).toThrow('X̄-R 分阶段未运行：阶段列只有 1 个连续段');
  });

  it('阶段列不存在：页面不再静默按普通 X̄-R 出结论，并可一键改为不分阶段', () => {
    importStepData();
    useApp.setState({ spcStageCol: '不存在的列' });
    const view = render(createElement(Spc, { T }));
    const text = view.container.textContent ?? '';
    expect(text).toContain('找不到阶段列“不存在的列”');
    expect(text).toContain('按 不存在的列（列不存在）');
    expect(text).not.toContain('检验结果');
    expect(saveOn('spc')).toMatchObject({ status: '未分析', metric: '找不到阶段列“不存在的列”' });

    useApp.setState({ page: 'spc' });
    fireEvent.click(view.getByRole('button', { name: '改为不分阶段' }));
    expect(useApp.getState().spcStageCol).toBeNull();
    expect(view.container.textContent).toContain('检验结果');
  });
});

describe('CORE-08 σ̂=0：页面/保存记录/专项报告同口径「不可判定」', () => {
  it('常数单值 0.1 的 EWMA 不再写「10 个失控点 · 需关注」，也不写「受控」', () => {
    useData.getState().importMatrix('常数.csv', ['读数'], Array.from({ length: 10 }, () => [0.1]), []);
    useApp.setState({ spcDataLayout: 'individuals', spcType: 'ewma', lsl: 0, tgt: 0.1, usl: 0.2 });

    const record = saveOn('spc');
    expect(record.status).toBe('未分析');
    expect(record.metric).toContain('σ̂=0');
    expect(record.metric).not.toContain('失控');

    const report = buildActiveAnalysisReport()!;
    expect(report.summary[0]).toContain('EWMA 不可判定');
    expect(report.summary.join(' ')).not.toContain('小漂移');

    const view = pageView();
    expect(view.advancedUnavailable).toContain('σ̂=0');
    expect(view.report.headline).toContain('EWMA 不可判定');
    expect(view.viol.size).toBe(0);
    const text = render(createElement(Spc, { T })).container.textContent ?? '';
    expect(text).toContain('不可判定：σ̂=0');
    expect(text).not.toContain('✓ 未检出失控点，过程受控');
  });

  it('组内零变异(R̄=0)的 CUSUM 同样不可判定', () => {
    const rows = [[10.1, 10.1], [10.2, 10.2], [10.1, 10.1], [10.0, 10.0], [10.1, 10.1], [10.2, 10.2], [10.0, 10.0], [10.1, 10.1]];
    useData.getState().importMatrix('分辨率不足.csv', ['a', 'b'], rows, []);
    useApp.setState({ spcDataLayout: 'rows', spcType: 'cusum', lsl: 9, tgt: 10.1, usl: 11 });
    expect(saveOn('spc')).toMatchObject({ status: '未分析' });
    expect(buildActiveAnalysisReport()!.summary[0]).toContain('CUSUM 不可判定');
    expect(pageView().viol.size).toBe(0);
  });
});
