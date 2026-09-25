/**
 * fix2609g G11-supplements UI/导出回归(编排方补充核实 S-1 / S-2)。
 * - S-1:EWMA/CUSUM 专项报告(HTML/Word/PPT/Excel)披露 λ、L / k、h,且与 SPC 页图注
 *   共用同一格式化函数(advancedSpcParams),不再只写「检出 N 个超限点」;
 * - S-2:AQL 页「进入放宽」须二次点击确认并以检验人为操作人写入 kind:'transition' 账本记录;
 *   转移记录可随 .qproj 导出/导入往返、随独立账本重启读回,AQL 专项报告同表留痕;
 *   篡改的转移记录在项目校验白名单处被拒绝。
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import {
  freshSwitchStatus, isAqlTransitionRecord, normalizeSwitchStatus, recordInspection, setSwitchConditions,
  type SwitchStatus,
} from '../../core';
import { CUSUM_K, cusumParamsText, ewmaParamsText } from '../../core/advancedSpcParams';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import type { AnalysisReportPayload } from '../../platform/analysisReportModel';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { applyProjectJson, buildProjectJson, projectStoreValidationError } from '../../platform/project';
import { buildXlsx } from '../../platform/xlsxExport';
import { useAnalyses } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';

const SPEC = { lsl: 0, tgt: 10, usl: 20 };
const AT = '2026-09-26T08:00:00.000Z';
const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];
const AQL_KEY = 'qp-aql-state-v1';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAnalyses.setState({ saved: [], lastError: null });
  useData.getState().resetDemo();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function exportedTexts(report: AnalysisReportPayload) {
  const M = useData.getState().model;
  const html = buildHtmlReport(M, SPEC, null, report);
  const [docxBytes, pptxBytes] = await Promise.all([
    buildDocx(M, SPEC, {}, null, report),
    buildPptx(M, SPEC, {}, null, report),
  ]);
  const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
  const word = await docx.file('word/document.xml')!.async('string');
  const slideNames = Object.keys(pptx.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const slides = (await Promise.all(slideNames.map((name) => pptx.file(name)!.async('string')))).join('\n');
  const wb = XLSX.read(buildXlsx(M, SPEC, null, report), { type: 'array' });
  const xlsx = wb.SheetNames
    .map((name) => XLSX.utils.sheet_to_json<Array<string | number>>(wb.Sheets[name], { header: 1 }).flat().join('|'))
    .join('\n');
  return { html, word, slides, xlsx };
}

describe('S-1 EWMA/CUSUM 专项报告披露设计常数', () => {
  const SUBGROUPS = [
    [10, 11, 9], [10.2, 10.8, 9.4], [9.8, 10.5, 9.2], [10.1, 10.9, 9.5],
    [10.3, 11.1, 9.7], [9.9, 10.7, 9.3], [10.2, 10.6, 9.6], [10, 10.8, 9.4],
  ];

  it('EWMA 子组数据:四格式均含 λ=0.2 · L=2.7 与 Minitab 默认差异,且与页面图注同文', async () => {
    useData.getState().importMatrix('EWMA常数', ['测量1', '测量2', '测量3'], SUBGROUPS);
    useApp.setState({ page: 'spc', spcType: 'ewma', spcDataLayout: 'rows' });
    const report = buildActiveAnalysisReport()!;
    const params = ewmaParamsText();
    expect(params).toBe('λ=0.2 · L=2.7(Montgomery 口径,Minitab 默认 L=3σ)');
    expect(report.summary.join('\n')).toContain(params);
    const table = report.tables.find((t) => t.title === 'EWMA 设计常数');
    expect(table?.rows.map((row) => row[0])).toEqual(['中心线 μ₀', 'σ(每点)', '权重 λ', '控制限宽度 L', 'UCL(末端)', 'LCL(末端)']);
    expect(table?.rows.find((row) => row[0] === '权重 λ')?.[1]).toBe(0.2);
    expect(table?.rows.find((row) => row[0] === '控制限宽度 L')?.[1]).toBe(2.7);
    const out = await exportedTexts(report);
    for (const [format, text] of Object.entries(out)) expect(text, format).toContain(params);

    render(<App />);
    expect(screen.getByText(`EWMA · ${params} · 对小漂移敏感`)).toBeTruthy();
  }, 60_000);

  it('CUSUM:子组 h=4、单值 h=5,报告与页面图注同一格式化函数', async () => {
    useData.getState().importMatrix('CUSUM子组', ['测量1', '测量2', '测量3'], SUBGROUPS);
    useApp.setState({ page: 'spc', spcType: 'cusum', spcDataLayout: 'rows' });
    const subgroupReport = buildActiveAnalysisReport()!;
    const h4 = cusumParamsText(CUSUM_K, 4);
    expect(h4).toBe('k=0.5 · h=4(与 Minitab 默认一致)');
    expect(subgroupReport.summary.join('\n')).toContain(h4);
    const out = await exportedTexts(subgroupReport);
    for (const [format, text] of Object.entries(out)) expect(text, format).toContain(h4);
    const { unmount } = render(<App />);
    expect(screen.getByText(`CUSUM · ${h4} · 累积和`)).toBeTruthy();
    unmount();

    act(() => {
      useData.getState().importMatrix('CUSUM单值', ['测量'], [[10], [10.4], [9.8], [10.1], [10.6], [9.7], [10.2], [10.3], [9.9], [10.5]]);
    });
    useApp.setState({ spcDataLayout: 'auto' });
    const individualReport = buildActiveAnalysisReport()!;
    const h5 = cusumParamsText(CUSUM_K, 5);
    expect(h5).toBe('k=0.5 · h=5(Montgomery 口径,Minitab 默认 h=4)');
    expect(individualReport.summary.join('\n')).toContain(h5);
    const cusumTable = individualReport.tables.find((t) => t.title === 'CUSUM 设计常数');
    expect(cusumTable?.rows.find((row) => row[0] === '判定限系数 h')?.[1]).toBe(5);
    const outIndividual = await exportedTexts(individualReport);
    for (const [format, text] of Object.entries(outIndividual)) expect(text, format).toContain(h5);
    render(<App />);
    expect(screen.getByText(`CUSUM · ${h5} · 累积和`)).toBeTruthy();
  }, 60_000);
});

/** 真实生产函数:10 批连续接收,转移得分 30,尚未勾选管理条件。 */
function eligibleNormal(): SwitchStatus {
  let status = freshSwitchStatus();
  for (let i = 1; i <= 10; i++) {
    status = recordInspection(status, {
      lot: 2000, level: 'II', aql: 1.0, regime: 'percent', nonconforming: 0,
      batchId: `B-${i}`, inspector: '张检', inspectedAt: `2026-09-${String(i).padStart(2, '0')}T08:00:00.000Z`,
    });
  }
  return status;
}

function aqlPage(aqlSwitch: SwitchStatus) {
  useApp.setState({
    page: 'aql', modal: null, openMenu: null,
    aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1.0, aqlRegime: 'percent',
    aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch,
  });
}

describe('S-2 AQL 进入放宽二次确认 + 转移账本', () => {
  it('勾齐管理条件先武装不转移;无检验人不能确认;确认后写入 transition 记录', () => {
    aqlPage(eligibleNormal());
    render(<App />);
    fireEvent.click(screen.getByLabelText('生产稳定'));
    expect(useApp.getState().aqlSwitch.productionSteady).toBe(true);
    expect(useApp.getState().aqlSwitch.records).toHaveLength(10);

    fireEvent.click(screen.getByLabelText('负责部门同意放宽'));
    // 二次确认前:状态与账本都不变
    expect(useApp.getState().aqlSwitch.state).toBe('normal');
    expect(useApp.getState().aqlSwitch.reducedApproved).toBe(false);
    expect(useApp.getState().aqlSwitch.records).toHaveLength(10);
    const confirm = screen.getByRole('button', { name: '再次点击确认转入放宽检验' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(/请先在上方填写检验人/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('检验人'), { target: { value: '李工-007' } });
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认转入放宽检验' }));
    const sw = useApp.getState().aqlSwitch;
    expect(sw.state).toBe('reduced');
    expect(sw.records).toHaveLength(11);
    expect(sw.records[10]).toMatchObject({
      kind: 'transition', action: 'conditions-met', stateBefore: 'normal', stateAfter: 'reduced',
      switchingScoreBefore: 30, switchingScoreAfter: 30, productionSteady: true, reducedApproved: true,
      inspector: '李工-007',
    });
    expect(screen.getByText('最近批次与状态转移追溯记录')).toBeTruthy();
    expect(screen.getByText('管理条件齐备 → 转放宽检验')).toBeTruthy();

    // 因其他条件恢复正常检验同样写账本,并带上操作人
    fireEvent.click(screen.getByRole('button', { name: '因其他条件恢复正常检验' }));
    const restored = useApp.getState().aqlSwitch;
    expect(restored.state).toBe('normal');
    expect(last(restored.records)).toMatchObject({
      kind: 'transition', action: 'restore-normal', inspector: '李工-007', note: '负责部门因其他条件决定恢复正常检验',
    });
  });

  it('武装后取消:不转移、不写账本', () => {
    aqlPage(setSwitchConditions(eligibleNormal(), { productionSteady: true }));
    render(<App />);
    fireEvent.click(screen.getByLabelText('负责部门同意放宽'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('button', { name: '再次点击确认转入放宽检验' })).toBeNull();
    expect(useApp.getState().aqlSwitch).toMatchObject({ state: 'normal', reducedApproved: false });
    expect(useApp.getState().aqlSwitch.records).toHaveLength(10);
  });

  it('转移记录进入 AQL 专项报告,并随 .qproj 导出/导入往返', async () => {
    const reduced = setSwitchConditions(
      setSwitchConditions(eligibleNormal(), { productionSteady: true }),
      { reducedApproved: true }, { operator: '李工', at: AT },
    );
    aqlPage(reduced);
    // 独立账本已落盘且通过校验
    const persisted = JSON.parse(localStorage.getItem(AQL_KEY)!);
    expect(projectStoreValidationError(AQL_KEY, persisted)).toBeNull();
    expect(last(persisted.aqlSwitch.records)).toMatchObject({ kind: 'transition', action: 'conditions-met' });

    const report = buildActiveAnalysisReport()!;
    const trace = report.tables.find((table) => table.title === '实际批次检验与追溯记录')!;
    const transitionRow = last(trace.rows)!;
    expect(transitionRow[1]).toBe('（状态转移）');
    expect(transitionRow[2]).toBe('李工');
    expect(String(last(transitionRow))).toContain('管理条件齐备 → 转放宽检验；生产稳定=是，负责部门同意=是；转移前得分 30');
    const out = await exportedTexts(report);
    for (const [format, text] of Object.entries(out)) expect(text, format).toContain('（状态转移）');

    const json = buildProjectJson('1.43.0');
    localStorage.clear();
    expect(applyProjectJson(json)).toBeNull();
    const imported = normalizeSwitchStatus(JSON.parse(localStorage.getItem(AQL_KEY)!).aqlSwitch);
    expect(imported.records).toEqual(reduced.records);
    expect(imported.records.filter(isAqlTransitionRecord)).toHaveLength(1);

    // 模拟独立重启:账本无隔离,转移记录读回
    vi.resetModules();
    const { useApp: freshApp } = await import('../../store/appStore');
    expect(freshApp.getState().aqlLedgerFault).toBeNull();
    expect(freshApp.getState().aqlSwitch.records).toEqual(reduced.records);
  }, 60_000);

  it('旧格式账本(无转移记录)仍通过校验;篡改的转移记录被项目白名单拒绝', () => {
    const legacy = eligibleNormal();
    const state = (aqlSwitch: unknown) => ({
      aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1, aqlRegime: 'percent', aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch,
    });
    expect(projectStoreValidationError(AQL_KEY, state(JSON.parse(JSON.stringify(legacy))))).toBeNull();

    const reduced = setSwitchConditions(
      setSwitchConditions(legacy, { productionSteady: true }),
      { reducedApproved: true }, { operator: '李工', at: AT },
    );
    const valid = JSON.parse(JSON.stringify(reduced)) as SwitchStatus;
    expect(projectStoreValidationError(AQL_KEY, state(valid))).toBeNull();
    const forged = JSON.parse(JSON.stringify(reduced)) as { records: Array<Record<string, unknown>> };
    forged.records[forged.records.length - 1].switchingScoreBefore = 6;
    forged.records[forged.records.length - 1].switchingScoreAfter = 6;
    expect(projectStoreValidationError(AQL_KEY, state(forged))).toBe('AQL 责任账本含有损坏或矛盾的状态转移记录');
  });
});
