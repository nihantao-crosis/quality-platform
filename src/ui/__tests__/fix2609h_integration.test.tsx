/** @vitest-environment jsdom */
/**
 * 2026-09 全面审查第 3 批 · 整合(G9 crossGroupNeeds #1)
 * 真实 ExportModal(通用报告)在分阶段配置下:
 * - SPC 段经 assessSpcCharts 第 5 参(buildActiveAnalysisExport().spcStage)按段内限值判异，
 *   失控计数与 SPC 页一致，结论行带分阶段说明；
 * - 能力段按能力口径(全局控制限、未分阶段)独立计数，不复用 SPC 段的段内 chartPointCount，
 *   并写明 capabilityStabilityCaliber 口径文案。
 * 修复前:Modals 以 4 参调用 assessSpcCharts(SPC 段按全局限值 20 个失控点，与 SPC 页 0 个不一致)。
 */
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../../App';
import { computeSpcPageView } from '../pages/Spc';
import {
  assessCapability, assessSpcCharts, computeCapability, countCapabilityViolations, DEFAULT_RULE_K,
  evaluateAndersonDarling, prepareSpcData, spcChartFamilyFor,
} from '../../core';
import { platform, type ExportJob } from '../../platform/adapter';
import { buildActiveAnalysisExport } from '../../platform/activeAnalysisReport';
import { stagedChartProps } from '../../platform/reportLabels';
import { useApp, type ExportFmt } from '../../store/appStore';
import { useData } from '../../store/dataStore';

const RULES = { r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false };
const RULE1 = { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
const STAGED_CALIBER = '稳定性按 X̄-R 图、全局控制限（未分阶段）评估；能力分析不分阶段，与 SPC 页分阶段结论口径不同';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({
    page: 'dashboard', modal: null, exportFmt: 'pdf', spcType: 'xbar-r', spcRules: { ...RULES }, spcRuleK: { ...DEFAULT_RULE_K },
    spcDataLayout: 'rows', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    spcSigmaMethod: 'classic', spcShowZones: true, selSub: null,
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    capabilityWarningAcknowledgement: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 与 fix2609g_spcpipelineUi 同构：20 子组 × n=5，改进前≈10.0 / 改进后≈10.5，段内平稳。 */
function importStepData() {
  const rows = Array.from({ length: 20 }, (_, i) => {
    const x = (i < 10 ? 10 : 10.5) + 0.02 * (((i * 7) % 5) - 2);
    const s = 0.1 + 0.02 * ((i * 3) % 4);
    return [x - 2 * s, x - s, x, x + s, x + 2 * s];
  });
  useData.getState().importMatrix('改进前后.csv', ['x1', 'x2', 'x3', 'x4', 'x5'], rows, [
    { name: '阶段', values: rows.map((_, i) => (i < 10 ? '改进前' : '改进后')) },
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

/** 能力口径(全局、未分阶段)的失控计数与据此得出的能力判定——独立于导出路径计算。 */
function globalCapabilityExpectation() {
  const { capabilityModel } = buildActiveAnalysisExport();
  const app = useApp.getState();
  const family = spcChartFamilyFor(capabilityModel, app.spcType);
  const count = countCapabilityViolations(capabilityModel, app.spcRules, app.spcRuleK, family);
  const cap = computeCapability(capabilityModel.all, capabilityModel.sigmaWithin, { lsl: app.lsl, tgt: app.tgt, usl: app.usl });
  const ad = evaluateAndersonDarling(capabilityModel.all).result;
  const status = (spcViolations: number) => assessCapability({
    cpk: cap.cpk, verdict: cap.verdict, adP: ad ? ad.p : null, n: capabilityModel.all.length, spcViolations,
  }).status;
  return { count, status: status(count), stagedStatus: status(0) };
}

describe('通用报告(ExportModal)分阶段：SPC 段随 SPC 页、能力段全局计数并写明口径', () => {
  it('HTML:SPC 段失控计数与 SPC 页一致(段内 0)，能力段按全局 20 个计数且带「未分阶段」文案', async () => {
    importStepData();
    useApp.setState({ spcStageCol: '阶段' });

    const view = pageView();
    expect(view.staged?.x.segments).toHaveLength(2);
    expect(view.violations.affectedPointCount).toBe(0);

    const expected = globalCapabilityExpectation();
    expect(expected.count).toBe(20);
    // 前提：两种计数给出的能力判定不同，否则本用例区分不了「复用段内计数」的回归。
    expect(expected.status).not.toBe(expected.stagedStatus);

    const html = (await exportVia('pdf')).text!;
    // SPC 段：段内判异 0 失控，与 SPC 页一致；结论行写明分阶段口径
    expect(html).toContain('✓ 未检出失控点，过程受控（按当前启用的判异准则）（分阶段：按「阶段」2 段段内控制限判异）');
    expect(html).not.toMatch(/各图累计 \d+ 个失控点（X̄ 图/);
    // 能力段：全局能力口径 20 个，判定随之为「不稳定」口径，并披露口径差异
    expect(html).toContain(`能力稳定性口径：${STAGED_CALIBER}（能力口径控制图累计 20 个失控点）`);
    expect(html).toContain(`>${expected.status}<`);
    expect(html).not.toContain(`>${expected.stagedStatus}<`);
  });

  it('Excel/Word:同样按段内判异输出 SPC 段，能力段写全局计数与口径', async () => {
    importStepData();
    useApp.setState({ spcStageCol: '阶段' });
    const expected = globalCapabilityExpectation();

    const workbook = XLSX.read((await exportVia('excel')).bytes!, { type: 'array' });
    const summary = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['统计摘要'], { header: 1 });
    expect(summary).toContainEqual(['过程稳定性', '控制图无失控信号']);
    expect(summary).toContainEqual(['能力稳定性口径', `能力稳定性口径：${STAGED_CALIBER}（能力口径控制图累计 20 个失控点）`]);
    expect(summary.find((row) => row[0] === '判定')?.[1]).toBe(expected.status);
    const violations = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['失控点'], { header: 1 });
    expect(violations[1][3]).toContain('分阶段：按「阶段」2 段段内控制限判异');

    const zip = await JSZip.loadAsync((await exportVia('word')).bytes!);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    expect(documentXml).toContain('（分阶段：按「阶段」2 段段内控制限判异）');
    expect(documentXml).toContain(`能力稳定性口径：${STAGED_CALIBER}（能力口径控制图累计 20 个失控点）`);
  });

  it('通用报告控制图按段内步进限值绘制(与红点判异同口径)', () => {
    importStepData();
    useApp.setState({ spcStageCol: '阶段' });
    const exported = buildActiveAnalysisExport();
    const app = useApp.getState();
    const assessment = assessSpcCharts(exported.model, app.spcRules, app.spcRuleK, exported.spcFamily, exported.spcStage);
    const location = stagedChartProps(assessment.location);
    const dispersion = stagedChartProps(assessment.dispersion);
    expect(location.stepSeries).toBe(true);
    expect(location.stageBoundaries).toEqual([10]);
    expect(new Set(location.uclSeries).size).toBe(2);
    expect(dispersion.stepSeries).toBe(true);
    // 未分阶段时不注入步进限值
    const global = assessSpcCharts(exported.model, app.spcRules, app.spcRuleK, exported.spcFamily);
    expect(stagedChartProps(global.location)).toEqual({});
  });

  it('未分阶段且视图一致：能力计数与 SPC 段相同，不加口径噪声', async () => {
    importStepData();
    const view = pageView();
    const expected = globalCapabilityExpectation();
    expect(view.violations.affectedPointCount).toBeGreaterThan(0);
    const html = (await exportVia('pdf')).text!;
    expect(html).not.toContain('能力稳定性口径');
    expect(html).not.toContain('分阶段：');
    expect(html).toContain(expected.status);
  });

  it('子组数据 + SPC 页 I-MR：能力段写明「与 SPC 页当前 I-MR 视图口径不同」', async () => {
    const rows = Array.from({ length: 20 }, () => [10, 10, 10, 10, 10, 10, 10, 10, 10, 13]);
    useData.getState().importMatrix('子组IMR.csv', rows[0].map((_, j) => `m${j + 1}`), rows, []);
    useApp.setState({ spcType: 'i-mr', spcRules: { ...RULE1 }, lsl: 5, tgt: 10.5, usl: 16, lslOn: true, uslOn: true });
    const html = (await exportVia('pdf')).text!;
    expect(html).toContain('能力稳定性口径：稳定性按 X̄-R 图评估；与 SPC 页当前 I-MR 视图口径不同');
  });
});
