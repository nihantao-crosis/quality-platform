/** @vitest-environment jsdom */
/**
 * 2026-09 全面审查第 3 批复审 · fix2609k G20-spcguard(真实页面 / 真实 App 导出 / 真实报告构建器)
 * (1) CORE-08 残余 + UI-03:零变异常数数据(53×0.1、13×0.03、25 组×3×0.09、3 组×n=2×0.1)在经典主题
 *     SPC 页、质量总览、保存记录、SPC 专项报告与通用导出中不抛 RangeError,统一「不可判定」;
 *     不可判定卡不再建议「改用 X̄-R/I-MR」;UCL/LCL/H/K 占位值不冒充真实参数。
 * (2) CORE-09 残余:工作表行高亮与 SPC 页同源(分阶段段内判异/阶段无效不高亮)。
 * (3) UI-12 残余:质量总览导出的通用报告 SPC 段与总览同一视图图型(I-MR)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../../App';
import { Spc, computeSpcPageView } from '../pages/Spc';
import { Dashboard } from '../pages/Dashboard';
import { Worksheet } from '../pages/Worksheet';
import { ControlChart } from '../charts/ControlChart';
import { chartTokens } from '../tokens';
import {
  assessSpcCharts, DEFAULT_RULE_K, evaluateSpcChartRules, mean, prepareSpcData, spcViewFamilyFor, withSigmaMethod,
} from '../../core';
import { platform, type ExportJob } from '../../platform/adapter';
import { buildActiveAnalysisExport, buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { useApp, type ExportFmt } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';

const T = chartTokens('经典', true);
const RULES = { r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false };
const RULE1 = { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
const RED = 'rgb(253, 236, 236)';

beforeEach(() => {
  localStorage.clear();
  useAnalyses.setState({ saved: [], lastError: null });
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({
    page: 'spc', modal: null, exportFmt: 'pdf', spcType: 'i-mr', spcRules: { ...RULES }, spcRuleK: { ...DEFAULT_RULE_K },
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    spcSigmaMethod: 'classic', spcShowZones: true, selSub: null, chartStyle: '经典',
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    capabilityWarningAcknowledgement: null, lslOn: false, uslOn: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function importSingle(value: number, count: number) {
  useData.getState().importMatrix(`常数${value}×${count}.csv`, ['读数'], Array.from({ length: count }, () => [value]), []);
  useApp.setState({ spcDataLayout: 'auto' });
}

function importGrouped(value: number, k: number, n: number) {
  useData.getState().importMatrix(
    `常数${value}×${k}×${n}.csv`, Array.from({ length: n }, (_, j) => `m${j + 1}`),
    Array.from({ length: k }, () => Array.from({ length: n }, () => value)), [],
  );
  useApp.setState({ spcDataLayout: 'rows' });
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

/** 走真实 App + ExportModal 导出一次，返回交给平台层的导出任务。 */
async function exportVia(fmt: ExportFmt): Promise<ExportJob> {
  useApp.setState({ page: 'dashboard', modal: 'export', exportFmt: fmt });
  const exportFile = vi.spyOn(platform, 'exportFile').mockResolvedValue('/tmp/通用报告');
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '导出' }));
  await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(1));
  const job = exportFile.mock.calls[0][0];
  cleanup();
  exportFile.mockRestore();
  return job;
}

describe('UI-03 经典主题亚 ulp 纵轴不再卡死/抛错', () => {
  it('ControlChart:3 个 0.1、中心线/控制限=均值(0.1+1ulp)可立即渲染', () => {
    const drifted = mean([0.1, 0.1, 0.1]);
    expect(drifted).not.toBe(0.1);
    const started = performance.now();
    const svg = renderToStaticMarkup(createElement(ControlChart, {
      T, data: [0.1, 0.1, 0.1], cl: drifted, ucl: drifted, lcl: drifted, clLabel: 'X̄',
    }));
    expect(performance.now() - started).toBeLessThan(500);
    expect(svg).toContain('<svg');
  });
});

describe('CORE-08 残余:Shewhart 零变异数据全链路「不可判定」', () => {
  const cases: Array<{ label: string; load: () => void; spcType: 'i-mr' | 'xbar-r' }> = [
    { label: '53×0.1 I-MR', load: () => importSingle(0.1, 53), spcType: 'i-mr' },
    { label: '13×0.03 I-MR', load: () => importSingle(0.03, 13), spcType: 'i-mr' },
    { label: '25 组×3×0.09 X̄-R', load: () => importGrouped(0.09, 25, 3), spcType: 'xbar-r' },
    { label: '3 组×n=2×0.1 X̄-R', load: () => importGrouped(0.1, 3, 2), spcType: 'xbar-r' },
  ];

  for (const { label, load, spcType } of cases) {
    it(`${label}:SPC 页经典主题渲染不抛错，显示不可判定且不建议改用 Shewhart 图`, () => {
      load();
      useApp.setState({ spcType });
      const text = render(createElement(Spc, { T })).container.textContent ?? '';
      expect(text).toContain('不可判定');
      expect(text).not.toMatch(/检测到 \d+ 个失控点|共 \d+ 个失控点/);
      expect(text).not.toContain('改用 X̄-R');
      expect(text).not.toContain('改用 I-MR');
      const view = pageView();
      expect(view.sigmaUnavailable).toContain('σ̂=0');
      expect(view.violations.affectedPointCount).toBe(0);
      expect(view.stats.find((row) => row.k === 'UCL')?.v).toBe('—（不可判定）');
    });

    it(`${label}:保存记录「未分析」+ 原因;专项报告不可判定、不出图;通用导出不抛错`, async () => {
      load();
      useApp.setState({ spcType, page: 'spc' });
      const record = useAnalyses.getState().saveCurrent()!;
      expect(record.status).toBe('未分析');
      expect(record.metric).toContain('σ̂=0');
      const report = buildActiveAnalysisReport()!;
      expect(report.title).toContain('不可判定');
      expect(report.charts).toHaveLength(0);
      expect(report.summary.join(' ')).not.toMatch(/失控点|过程受控/);
      const limits = report.tables.find((table) => table.title === '控制限')!;
      expect(limits.rows[0].slice(2, 4)).toEqual(['—（不可判定）', '—（不可判定）']);

      const html = (await exportVia('pdf')).text!;
      expect(html).toContain('不可判定');
      expect(html).not.toContain('未检出失控点');
    });
  }

  it('53×0.1 选 EWMA:总览按 I-MR 回落后同样不可判定(不再「I 图观测 1 违反准则 1」);EWMA 卡不再建议改用 I-MR', () => {
    importSingle(0.1, 53);
    useApp.setState({ spcType: 'ewma', spcRules: { ...RULE1 }, page: 'dashboard' });
    const dash = render(createElement(Dashboard, { T })).container.textContent ?? '';
    expect(dash).not.toMatch(/违反准则/);
    expect(dash).toContain('不可判定');
    expect(dash).not.toContain('✓ 过程受控');
    cleanup();
    const view = pageView();
    expect(view.report.headline).toContain('不可判定');
    expect(view.report.headline).not.toMatch(/改用 (X̄-R|I-MR)/);
  });
});

describe('CORE-08 P3:近零 σ̂ 与不可判定占位值', () => {
  function importFloatTail() {
    const values = [...Array.from({ length: 19 }, () => 0.1), 0.10000000000000002];
    useData.getState().importMatrix('浮点尾差.csv', ['读数'], values.map((value) => [value]), []);
    useApp.setState({ spcDataLayout: 'auto' });
  }

  it('19×0.1 + 1 个 0.1+1ulp:EWMA 不可判定(修复前 20/20 失控),统计卡 UCL/LCL 与报告常数表不写占位值', () => {
    importFloatTail();
    useApp.setState({ spcType: 'ewma', page: 'spc' });
    const view = pageView();
    expect(view.ewma.unavailableReason).toContain('σ̂ 小于数值分辨率');
    expect(view.violations.affectedPointCount).toBe(0);
    expect(view.stats.find((row) => row.k === 'UCL（末端）')?.v).toBe('—（不可判定）');
    expect(view.stats.find((row) => row.k === 'LCL（末端）')?.v).toBe('—（不可判定）');
    const text = render(createElement(Spc, { T })).container.textContent ?? '';
    expect(text).toContain('不可判定');
    cleanup();

    expect(useAnalyses.getState().saveCurrent()!.status).toBe('未分析');
    const report = buildActiveAnalysisReport()!;
    const params = report.tables.find((table) => table.title === 'EWMA 设计常数')!;
    expect(params.rows.find((row) => row[0] === 'UCL(末端)')?.[1]).toBe('—（不可判定）');
    expect(params.rows.find((row) => row[0] === 'LCL(末端)')?.[1]).toBe('—（不可判定）');
    expect(params.note).not.toContain('可逐点复算');
    expect(report.charts).toHaveLength(0);
  });

  it('CUSUM 不可判定:统计卡与专项报告 H/K 写「不可判定」而非 0', () => {
    importSingle(0.1, 53);
    useApp.setState({ spcType: 'cusum', page: 'spc' });
    const view = pageView();
    expect(view.stats.find((row) => row.k === '判定限 H')?.v).toBe('—（不可判定）');
    expect(view.stats.find((row) => row.k === '允差 K')?.v).toBe('—（不可判定）');
    const params = buildActiveAnalysisReport()!.tables.find((table) => table.title === 'CUSUM 设计常数')!;
    const joined = params.rows.map((row) => row.join('|')).join('\n');
    expect(joined).toContain('K = k·σ = —（不可判定）');
    expect(joined).toContain('H = h·σ = —（不可判定）');
  });
});

describe('CORE-09 残余:工作表行高亮与 SPC 页同源', () => {
  /** 原发现 6×2 分阶段夹具:两段均值差 10,段内平稳。全局限值下 6 个均值全红，段内 0 失控。 */
  function importStaged(labels: string[]) {
    const rows = [[10, 10.1], [10.05, 10.15], [10, 10.1], [20, 20.1], [20.05, 20.15], [20, 20.1]];
    useData.getState().importMatrix('分阶段6x2.csv', ['m1', 'm2'], rows, [{ name: '阶段', values: labels }]);
    useApp.setState({ page: 'worksheet', spcType: 'xbar-r', spcDataLayout: 'rows', spcStageCol: '阶段' });
  }
  const redCells = (container: HTMLElement) => [...container.querySelectorAll('td')]
    .filter((cell) => (cell as HTMLTableCellElement).style.background === RED).length;

  it('分阶段有效:SPC 页 0 点 → 工作表 0 红格(修复前 6 个均值全红),并注明段内判异', () => {
    importStaged(['前', '前', '前', '后', '后', '后']);
    const view = pageView();
    expect(view.staged?.x.segments).toHaveLength(2);
    expect(view.violations.affectedPointCount).toBe(0);
    const { container } = render(<Worksheet />);
    expect(redCells(container)).toBe(0);
    expect(container.textContent).toContain('分阶段段内控制限判异');
  });

  it('分阶段无效(只有 1 段):SPC 页拒绝出结论 → 工作表不高亮并提示「分阶段未运行」', () => {
    importStaged(['全部', '全部', '全部', '全部', '全部', '全部']);
    expect(pageView().stageBlocked).toBeTruthy();
    const { container } = render(<Worksheet />);
    expect(redCells(container)).toBe(0);
    expect(container.textContent).toContain('SPC 分阶段未运行');
  });

  it('未分阶段:高亮仍与 SPC 页全局判异逐点一致(口径不变)', () => {
    importStaged(['前', '前', '前', '后', '后', '后']);
    useApp.setState({ spcStageCol: null });
    const view = pageView();
    const { container } = render(<Worksheet />);
    expect(view.viol.size).toBe(6);
    expect(redCells(container)).toBe(view.viol.size + (view.dispViolByChart.values().next().value?.size ?? 0));
  });
});

describe('UI-12 残余:质量总览导出与总览告警同源(方案 a)', () => {
  function importImrSubgroups() {
    // 20 组×n=10:组内 9 个 10 + 1 个 13,X̄-R 平稳(0 失控),逐点 I-MR 大量超限
    const rows = Array.from({ length: 20 }, () => [10, 10, 10, 10, 10, 10, 10, 10, 10, 13]);
    useData.getState().importMatrix('子组20x10.csv', rows[0].map((_, j) => `m${j + 1}`), rows, []);
    useApp.setState({ page: 'dashboard', spcType: 'i-mr', spcRules: { ...RULE1 }, spcDataLayout: 'rows' });
  }

  it('总览显示 I-MR 告警;导出通用报告 SPC 段同为 I-MR,失控计数与总览一致(修复前写 X̄-R「未检出失控点」)', async () => {
    importImrSubgroups();
    const app = useApp.getState();
    const data = useData.getState();
    const prepared = prepareSpcData(data.model, data.textCols, { layout: 'rows', valueColumn: null, subgroupColumn: null });
    const SM = withSigmaMethod(prepared.model!, app.spcSigmaMethod);
    const dashFamily = spcViewFamilyFor(SM, app.spcType);
    const dashEval = evaluateSpcChartRules(SM, app.spcRules, app.spcRuleK, dashFamily, true);
    expect(dashFamily).toBe('i-mr');
    expect(dashEval.location.viol.size).toBeGreaterThan(0);

    const dash = render(createElement(Dashboard, { T })).container.textContent ?? '';
    expect(dash).toContain('I-MR · 200 观测');
    expect(dash).toMatch(/I 图观测 \d+ 违反准则 1|MR 图点 \d+ 违反准则 1/);
    cleanup();

    const exported = buildActiveAnalysisExport();
    expect(exported.spcFamily).toBe('i-mr');
    const assessment = assessSpcCharts(exported.model, app.spcRules, app.spcRuleK, exported.spcFamily, exported.spcStage);
    expect(assessment.locationPoints).toBe(dashEval.location.viol.size);
    expect(assessment.dispersionPoints).toBe(dashEval.dispersion.viol.size);

    const html = (await exportVia('pdf')).text!;
    expect(html).toContain('SPC 控制图（I-MR）');
    expect(html).not.toContain('SPC 控制图（X̄-R）');
    expect(html).not.toContain('✓ 未检出失控点');
    // 能力段仍按子组 X̄-R 口径独立计数，并披露与 SPC 页 I-MR 视图不同
    expect(html).toContain('与 SPC 页当前 I-MR 视图口径不同');
  });
});
