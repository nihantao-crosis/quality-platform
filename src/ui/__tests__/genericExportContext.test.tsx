/** Dashboard/Worksheet 通用导出：数据角色、单双侧规格与四格式必须和页面一致。
 * @vitest-environment jsdom
 */
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../../App';
import {
  assessSpcCharts, computeCapability, countCapabilityViolations, DEFAULT_RULE_K, nf,
} from '../../core';
import { buildActiveAnalysisExport } from '../../platform/activeAnalysisReport';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { platform } from '../../platform/adapter';
import { textReport } from '../../platform/report';
import { buildXlsx } from '../../platform/xlsxExport';
import { DEFAULT_SPC_RULES, useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';

const COLUMNS = ['子组', '测量1', '测量2', '测量3', '测量4', '测量5'];
const ROWS = [
  [1, 25.00, 25.02, 24.99, 25.01, 25.00],
  [2, 25.01, 25.03, 25.00, 25.02, 25.01],
  [3, 24.99, 25.00, 25.01, 24.98, 25.00],
];
const SPEC = { lsl: 24.8, tgt: 25, usl: 25.2 };

function importNumericSubgroupTable() {
  useData.getState().importMatrix('数值子组ID.csv', COLUMNS, ROWS);
  useApp.setState({ lsl: SPEC.lsl, tgt: SPEC.tgt, usl: SPEC.usl, lslOn: true, uslOn: true });
}

function officeTextRuns(xml: string): string[] {
  return [...xml.matchAll(/<(?:w|a):t(?: [^>]*)?>(.*?)<\/(?:w|a):t>/g)]
    .map((match) => match[1]);
}

function expectSingleSidedCapabilityRows(xml: string, namespace: 'word' | 'ppt') {
  const runs = officeTextRuns(xml);
  const labels = ['Cp', 'Cpk', 'Pp', 'Ppk', 'Cpm', 'CPU', 'CPL', 'Z.bench', 'σ 水平', 'PPM(整体)'];
  const start = runs.findIndex((value, index) => labels.every((label, offset) => runs[index + offset] === label));
  expect(start, `${namespace} 应包含完整能力指标表头`).toBeGreaterThanOrEqual(0);
  const values = runs.slice(start + labels.length, start + labels.length * 2);
  expect(values[0]).toBe('—'); // Cp
  expect(values[2]).toBe('—'); // Pp
  expect(values[4]).toBe('—'); // Cpm
}

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'dashboard', modal: null, exportFmt: 'pdf',
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcSigmaMethod: 'classic',
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    spcRules: DEFAULT_SPC_RULES, spcRuleK: DEFAULT_RULE_K,
    lsl: SPEC.lsl, tgt: SPEC.tgt, usl: SPEC.usl, lslOn: true, uslOn: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('通用导出数据上下文', () => {
  it('Dashboard/Worksheet 均排除数值子组 ID，不再回退 raw n=6/N=18', () => {
    importNumericSubgroupTable();
    for (const page of ['dashboard', 'worksheet'] as const) {
      useApp.setState({ page });
      const exported = buildActiveAnalysisExport();
      expect(exported.report).toBeUndefined();
      expect(exported.model).toMatchObject({ n: 5, k: 3 });
      expect(exported.model.all).toHaveLength(15);
      expect(exported.model.colNames).toEqual(COLUMNS.slice(1));
      expect(exported.capabilityModel).toBe(exported.model);
    }
  });

  it('HTML/Excel/Word/PPT 使用同一解析模型，数据表头只有一个“子组”', async () => {
    importNumericSubgroupTable();
    const { model, capabilityModel } = buildActiveAnalysisExport();
    const assessment = assessSpcCharts(model, DEFAULT_SPC_RULES, DEFAULT_RULE_K);
    const capCount = countCapabilityViolations(capabilityModel, DEFAULT_SPC_RULES, DEFAULT_RULE_K);
    const expected = computeCapability(capabilityModel.all, capabilityModel.sigmaWithin, SPEC);

    const html = buildHtmlReport(model, SPEC, assessment, undefined, capabilityModel, capCount);
    const workbook = XLSX.read(buildXlsx(model, SPEC, assessment, undefined, capabilityModel, capCount), { type: 'array' });
    const [docxBytes, pptxBytes] = await Promise.all([
      buildDocx(model, SPEC, {}, assessment, undefined, capabilityModel, capCount),
      buildPptx(model, SPEC, {}, assessment, undefined, capabilityModel, capCount),
    ]);
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
    const wordXml = await docx.file('word/document.xml')!.async('string');
    const slideNames = Object.keys(pptx.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const slideXml = (await Promise.all(slideNames.map((name) => pptx.file(name)!.async('string')))).join('\n');

    for (const content of [html, wordXml, slideXml]) {
      expect(content).toContain('3 子组 × 5 测量 = 15 观测');
      expect(content).not.toContain('3 子组 × 6 测量 = 18 观测');
      expect(content).toContain(`Cpk ${nf(expected.cpk, 2)}`);
    }

    const dataRows = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['数据'], { header: 1 });
    expect(dataRows[0]).toEqual(['子组', ...COLUMNS.slice(1), '均值', '极差']);
    expect(dataRows[0].filter((value) => value === '子组')).toHaveLength(1);
    const summary = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['统计摘要'], { header: 1 });
    expect(summary).toContainEqual(['观测数 N', 15]);
    expect(summary.find((row) => row[0] === 'Cpk')?.[1]).toBeCloseTo(expected.cpk, 3);
  });

  it('自定义能力子组时四格式分别使用 SPC 与能力模型，能力判定不借用 SPC 的失控点', async () => {
    // 三段 1→6：I 图按 K3=6 命中趋势；按每 6 个组成能力子组后，三个均值/极差完全相同、能力口径受控。
    const values = Array.from({ length: 3 }, () => [1, 2, 3, 4, 5, 6]).flat();
    useData.getState().importMatrix('双口径.csv', ['测量'], values.map((value) => [value]));
    useApp.setState({
      page: 'dashboard', spcDataLayout: 'individuals', spcValueCol: '测量',
      capSubgroupMode: 'const', capSubgroupSize: 6, capValueCol: '测量',
      lsl: -10, tgt: 3.5, usl: 20,
    });
    const { model, capabilityModel } = buildActiveAnalysisExport();
    expect(model).toMatchObject({ n: 1, k: 18 });
    expect(capabilityModel).toMatchObject({ n: 6, k: 3 });
    const assessment = assessSpcCharts(model, DEFAULT_SPC_RULES, DEFAULT_RULE_K);
    const capCount = countCapabilityViolations(capabilityModel, DEFAULT_SPC_RULES, DEFAULT_RULE_K);
    expect(assessment.chartPointCount).toBeGreaterThan(0);
    expect(capCount).toBe(0);
    const spec = { lsl: -10, tgt: 3.5, usl: 20 };
    const expected = computeCapability(capabilityModel.all, capabilityModel.sigmaWithin, spec);
    const html = buildHtmlReport(model, spec, assessment, undefined, capabilityModel, capCount);
    const workbook = XLSX.read(buildXlsx(model, spec, assessment, undefined, capabilityModel, capCount), { type: 'array' });
    const [docxBytes, pptxBytes] = await Promise.all([
      buildDocx(model, spec, {}, assessment, undefined, capabilityModel, capCount),
      buildPptx(model, spec, {}, assessment, undefined, capabilityModel, capCount),
    ]);
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
    const wordXml = await docx.file('word/document.xml')!.async('string');
    const slideNames = Object.keys(pptx.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const slideXml = (await Promise.all(slideNames.map((name) => pptx.file(name)!.async('string')))).join('\n');

    for (const content of [html, wordXml, slideXml]) {
      expect(content).toContain('SPC：18 个单值观测；能力：3 子组 × 6 测量 = 18 观测');
      expect(content).toContain(`Cpk ${nf(expected.cpk, 2)}`);
      expect(content).not.toContain('过程不稳定 · 能力充足仅描述样本');
    }
    const summary = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['统计摘要'], { header: 1 });
    expect(summary).toContainEqual(['SPC 观测数 N', 18]);
    expect(summary).toContainEqual(['能力观测数 N', 18]);
    expect(summary).not.toContainEqual(['观测数 N', 18]);
    expect(summary).toContainEqual(['判定', '能力充足']);
    expect(String(summary.find((row) => row[0] === '过程稳定性')?.[1])).toContain('失控点');
  });

  it('角色有歧义时明确阻断通用导出，不静默使用 raw model', () => {
    useData.getState().importMatrix('歧义.csv', ['子组', '直径', '温度'], [
      [1, 10, 100], [1, 11, 101], [2, 12, 102], [2, 13, 103],
    ]);
    expect(() => buildActiveAnalysisExport()).toThrow(/请选择哪一列是测量值|数据角色无效/);
  });

  it('SPC/能力专项页角色错误时保持优雅降级：导出「未运行」专项报告而非整体阻断', () => {
    useData.getState().importMatrix('歧义.csv', ['子组', '直径', '温度'], [
      [1, 10, 100], [1, 11, 101], [2, 12, 102], [2, 13, 103],
    ]);
    useApp.setState({ page: 'spc' });
    const spcExport = buildActiveAnalysisExport();
    expect(spcExport.report?.summary.join('')).toContain('未运行');
    expect(spcExport.report?.warnings.join('')).toMatch(/请选择哪一列是测量值|数据角色/);
    useApp.setState({ page: 'capability' });
    const capExport = buildActiveAnalysisExport();
    expect(capExport.report?.summary.join('')).toContain('未运行');
  });
});

describe('通用导出单双侧规格', () => {
  it('仅上限在四格式均保持单侧：Cpk=CPU，关闭的 LSL 不进入图或文本', async () => {
    importNumericSubgroupTable();
    const { model, capabilityModel } = buildActiveAnalysisExport();
    const assessment = assessSpcCharts(model, DEFAULT_SPC_RULES, DEFAULT_RULE_K);
    const spec = { lsl: null, tgt: 25, usl: 25.2 };
    const expected = computeCapability(capabilityModel.all, capabilityModel.sigmaWithin, spec);
    const capCount = countCapabilityViolations(capabilityModel, DEFAULT_SPC_RULES, DEFAULT_RULE_K);

    const html = buildHtmlReport(model, spec, assessment, undefined, capabilityModel, capCount);
    const text = textReport(model, spec, assessment, capabilityModel, capCount);
    const workbook = XLSX.read(buildXlsx(model, spec, assessment, undefined, capabilityModel, capCount), { type: 'array' });
    const [docxBytes, pptxBytes] = await Promise.all([
      buildDocx(model, spec, {}, assessment, undefined, capabilityModel, capCount),
      buildPptx(model, spec, {}, assessment, undefined, capabilityModel, capCount),
    ]);
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
    const wordXml = await docx.file('word/document.xml')!.async('string');
    const slideNames = Object.keys(pptx.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const slideXml = (await Promise.all(slideNames.map((name) => pptx.file(name)!.async('string')))).join('\n');

    expect(expected.cp).toBeNull();
    expect(expected.cpk).toBe(expected.cpu);
    for (const content of [text, html, wordXml, slideXml]) {
      expect(content).toContain('无下限 / 25.00 / 25.20');
      expect(content).toContain(`Cpk ${nf(expected.cpk, 2)}`);
      expect(content).not.toContain('24.80 / 25.00 / 25.20');
    }
    expect(text).toContain('Cp —');
    expect(text).toContain('Pp —');
    expectSingleSidedCapabilityRows(wordXml, 'word');
    expectSingleSidedCapabilityRows(slideXml, 'ppt');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const capabilityChart = [...doc.querySelectorAll('h2')]
      .find((node) => node.textContent?.startsWith('3. 过程能力'))?.nextElementSibling;
    const labels = [...(capabilityChart?.querySelectorAll('svg text') ?? [])].map((node) => node.textContent);
    expect(labels).not.toContain('LSL');
    expect(labels).toContain('USL');

    const summary = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['统计摘要'], { header: 1 });
    expect(summary).toContainEqual(['规格 LSL / 目标 / USL', '无下限 / 25 / 25.2']);
    expect(summary.find((row) => row[0] === 'Cp')?.[1]).toBe('—');
    expect(summary.find((row) => row[0] === 'Cpk')?.[1]).toBeCloseTo(expected.cpk, 3);
  });

  it('仅下限在文本/HTML/Excel/Word/PPT 对称保持 Cpk=CPL，并明确显示无上限', async () => {
    importNumericSubgroupTable();
    const { model, capabilityModel } = buildActiveAnalysisExport();
    const assessment = assessSpcCharts(model, DEFAULT_SPC_RULES, DEFAULT_RULE_K);
    const spec = { lsl: 24.8, tgt: 25, usl: null };
    const expected = computeCapability(capabilityModel.all, capabilityModel.sigmaWithin, spec);
    const capCount = countCapabilityViolations(capabilityModel, DEFAULT_SPC_RULES, DEFAULT_RULE_K);
    const text = textReport(model, spec, assessment, capabilityModel, capCount);
    const html = buildHtmlReport(model, spec, assessment, undefined, capabilityModel);
    const workbook = XLSX.read(buildXlsx(model, spec, assessment, undefined, capabilityModel, capCount), { type: 'array' });
    const [docxBytes, pptxBytes] = await Promise.all([
      buildDocx(model, spec, {}, assessment, undefined, capabilityModel, capCount),
      buildPptx(model, spec, {}, assessment, undefined, capabilityModel, capCount),
    ]);
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
    const wordXml = await docx.file('word/document.xml')!.async('string');
    const slideNames = Object.keys(pptx.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const slideXml = (await Promise.all(slideNames.map((name) => pptx.file(name)!.async('string')))).join('\n');
    expect(expected.cpk).toBe(expected.cpl);
    for (const content of [text, html, wordXml, slideXml]) {
      expect(content).toContain('24.80 / 25.00 / 无上限');
      expect(content).toContain(`Cpk ${nf(expected.cpk, 2)}`);
    }
    expectSingleSidedCapabilityRows(wordXml, 'word');
    expectSingleSidedCapabilityRows(slideXml, 'ppt');
    const summary = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['统计摘要'], { header: 1 });
    expect(summary).toContainEqual(['规格 LSL / 目标 / USL', '24.8 / 25 / 无上限']);
    expect(summary.find((row) => row[0] === 'Cpk')?.[1]).toBeCloseTo(expected.cpk, 3);
  });

  it('真实 ExportModal 使用 lslOn/uslOn，而不是休眠的规格数值', async () => {
    importNumericSubgroupTable();
    useApp.setState({
      page: 'worksheet', modal: 'export', exportFmt: 'pdf',
      lsl: 24.8, lslOn: false, tgt: 25, usl: 25.2, uslOn: true,
    });
    const exportFile = vi.spyOn(platform, 'exportFile').mockResolvedValue('/tmp/单侧报告.html');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(1));
    const job = exportFile.mock.calls[0][0];
    expect(job.text).toContain('无下限 / 25.00 / 25.20');
    expect(job.text).not.toContain('24.80 / 25.00 / 25.20');
  });
});
