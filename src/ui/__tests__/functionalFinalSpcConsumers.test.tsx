/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assessSpcCharts, computeCapability, computeVarModel, countCapabilityViolations, withSigmaMethod, nf } from '../../core';
import { buildActiveAnalysisExport, buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { buildExportJob } from '../../platform/report';
import { useAnalyses } from '../../store/analyses';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { buildXlsx } from '../../platform/xlsxExport';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Dashboard } from '../pages/Dashboard';
import { Capability } from '../pages/Capability';
import { Worksheet } from '../pages/Worksheet';
import { chartTokens } from '../tokens';

const rows = [
  ...Array.from({ length: 11 }, () => [-1, -1, 1, 1, 1]),
  [0.4, 0.4, 2.4, 2.4, 2.4],
];

const onlyRule1 = {
  r1: true,
  r2: false,
  r3: false,
  r4: false,
  r5: false,
  r6: false,
  r7: false,
  r8: false,
};

beforeEach(() => {
  useData.setState({
    model: computeVarModel('Xbar-S反例.csv', ['M1', 'M2', 'M3', 'M4', 'M5'], rows),
    textCols: [],
    pendingCells: [],
  });
  useApp.setState({
    spcType: 'xbar-s',
    page: 'dashboard',
    spcDataLayout: 'rows',
    spcValueCol: null,
    spcSubgroupCol: null,
    spcSigmaMethod: 'classic',
    spcRules: onlyRule1,
    selSub: null,
    lslOn: false,
    uslOn: false,
  });
  useAnalyses.setState({ saved: [], lastError: null });
});

afterEach(cleanup);

function worksheetHeaders(container: HTMLElement): string[] {
  const rows = container.querySelectorAll('table thead tr');
  return [...rows[1].querySelectorAll('th')].map((cell) => cell.textContent ?? '');
}

describe('Dashboard / Worksheet 跟随 Xbar-S 口径', () => {
  it('Dashboard 的 Xbar-S 均值限值不再借用 Xbar-R 制造假告警', () => {
    const xs = render(<Dashboard T={chartTokens('经典', true)} />);
    expect(xs.container.textContent).not.toContain('X̄ 图子组 12 违反准则 1');
    expect(xs.container.textContent).toContain('✓ 过程受控，暂无告警');
    cleanup();

    useApp.setState({ spcType: 'xbar-r' });
    const xr = render(<Dashboard T={chartTokens('经典', true)} />);
    expect(xr.container.textContent).toContain('X̄ 图子组 12 违反准则 1');
  });

  it('Worksheet 在 Xbar-S 显示标准差列并用 S 值，最后子组均值不误标红', () => {
    const view = render(<Worksheet />);
    const headers = worksheetHeaders(view.container);
    expect(headers).toContain('标准差');
    expect(headers).not.toContain('极差');

    const lastRow = view.container.querySelector('#ws-row-11')!;
    const cells = [...lastRow.querySelectorAll('td')];
    const meanCell = cells[cells.length - 2] as HTMLTableCellElement;
    const dispersionCell = cells[cells.length - 1] as HTMLTableCellElement;
    const model = useData.getState().model;
    expect(meanCell.style.background).toBe('');
    expect(dispersionCell.textContent).toBe(nf(model.svals[11], 3));
    expect(dispersionCell.title).toBe(String(model.svals[11]));
  });

  it('Worksheet 的 Xbar-R 仍显示极差并按 R 限值标记同一反例', () => {
    useApp.setState({ spcType: 'xbar-r' });
    const view = render(<Worksheet />);
    const headers = worksheetHeaders(view.container);
    expect(headers).toContain('极差');
    expect(headers).not.toContain('标准差');

    const lastRow = view.container.querySelector('#ws-row-11')!;
    const cells = [...lastRow.querySelectorAll('td')];
    const meanCell = cells[cells.length - 2] as HTMLTableCellElement;
    const dispersionCell = cells[cells.length - 1] as HTMLTableCellElement;
    expect(meanCell.style.background).toBe('rgb(253, 236, 236)');
    expect(dispersionCell.textContent).toBe(nf(2, 3));
    expect(dispersionCell.title).toBe('2');
  });

  it('通用 HTML/Excel/Word/PPT 从同一 Xbar-S assessment 取 S 图、S 限值和标准差表头', async () => {
    const model = useData.getState().model;
    const { buildActiveAnalysisExport } = await import('../../platform/activeAnalysisReport');
    expect(buildActiveAnalysisExport().spcFamily).toBe('xbar-s');
    const assessment = assessSpcCharts(model, onlyRule1, useApp.getState().spcRuleK, 'xbar-s');
    expect(assessment.family).toBe('xbar-s');
    expect(assessment.location.ucl).toBe(model.uclXs);
    expect(assessment.dispersion).toMatchObject({ data: model.svals, cl: model.sCl, ucl: model.uclS, lcl: model.lclS, label: 'S', clLabel: 'S̄' });
    expect(assessment.dispersion.ucl).not.toBe(model.uclR);

    const spec = { lsl: null, tgt: 0, usl: null };
    const html = buildHtmlReport(model, spec, assessment);
    const workbook = XLSX.read(buildXlsx(model, spec, assessment), { type: 'array' });
    const [docx, pptx] = await Promise.all([
      buildDocx(model, spec, {}, assessment),
      buildPptx(model, spec, {}, assessment),
    ]);
    const word = await JSZip.loadAsync(docx);
    const slides = await JSZip.loadAsync(pptx);
    const wordXml = await word.file('word/document.xml')!.async('string');
    const slideXml = (await Promise.all(Object.keys(slides.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map((name) => slides.file(name)!.async('string')))).join('\n');
    const dataRows = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['数据'], { header: 1 });

    expect(html).toContain('X̄-S');
    expect(wordXml).toContain('X̄-S');
    expect(slideXml).toContain('SPC 离散图（S）');
    expect(dataRows[0]).toContain('标准差');
    expect(dataRows[0]).not.toContain('极差');
  });
});

describe('能力稳定性跟随 σ̂ 方法（12 组反例）', () => {
  const spec = { lsl: -10, tgt: 0, usl: 10 };

  function prepareCapability(spcType: 'xbar-r' | 'xbar-s', sigmaMethod: 'classic' | 'pooled') {
    useData.setState({
      model: computeVarModel('能力12组反例.csv', ['M1', 'M2', 'M3', 'M4', 'M5'], rows),
      textCols: [], pendingCells: [],
    });
    useApp.setState({
      page: 'dashboard', spcType, spcSigmaMethod: sigmaMethod,
      spcDataLayout: 'rows', spcValueCol: null, spcSubgroupCol: null,
      capSubgroupMode: 'spc', capValueCol: null, capSubgroupIdCol: null,
      spcRules: onlyRule1, lsl: spec.lsl, tgt: spec.tgt, usl: spec.usl, lslOn: true, uslOn: true,
    });
    return useData.getState().model;
  }

  it('pooled X̄-R 的稳定性计数不再悄然按 classic 回退；Cpk 的 sigmaWithin 保持不变', () => {
    const raw = prepareCapability('xbar-r', 'pooled');
    const classic = withSigmaMethod(raw, 'classic');
    const pooled = withSigmaMethod(raw, 'pooled');
    const classicCount = countCapabilityViolations(classic, onlyRule1, useApp.getState().spcRuleK, 'xbar-r');
    const pooledCount = countCapabilityViolations(pooled, onlyRule1, useApp.getState().spcRuleK, 'xbar-r');
    expect(classicCount).toBeGreaterThan(0);
    expect(pooledCount).toBe(0);
    expect(computeCapability(classic.all, classic.sigmaWithin, spec).cpk)
      .toBe(computeCapability(pooled.all, pooled.sigmaWithin, spec).cpk);

    const dashboard = render(<Dashboard T={chartTokens('经典', true)} />);
    expect(dashboard.container.textContent).not.toContain('控制图 1 个失控点');
    cleanup();
    const capability = render(<Capability T={chartTokens('经典', true)} />);
    expect(capability.container.textContent).not.toContain('过程不稳定');
  });

  it('pooled X̄-S 的真实 HTML/XLSX/DOCX/PPTX 构建器共同输出 S、c₄σ̂ 与零失控结论', async () => {
    const raw = prepareCapability('xbar-s', 'pooled');
    const pooled = withSigmaMethod(raw, 'pooled');
    const assessment = assessSpcCharts(pooled, onlyRule1, useApp.getState().spcRuleK, 'xbar-s');
    expect(assessment).toMatchObject({ chartPointCount: 0, dispersion: { label: 'S', clLabel: 'c₄σ̂' } });

    const html = buildHtmlReport(pooled, spec, assessment, undefined, pooled, 0);
    const workbook = XLSX.read(buildXlsx(pooled, spec, assessment, undefined, pooled, 0), { type: 'array' });
    const [docx, pptx] = await Promise.all([
      buildDocx(pooled, spec, {}, assessment, undefined, pooled, 0),
      buildPptx(pooled, spec, {}, assessment, undefined, pooled, 0),
    ]);
    const word = await JSZip.loadAsync(docx);
    const slides = await JSZip.loadAsync(pptx);
    const wordXml = await word.file('word/document.xml')!.async('string');
    const slideXml = (await Promise.all(Object.keys(slides.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map((name) => slides.file(name)!.async('string')))).join('\n');
    const workbookText = ['数据', '统计摘要', '失控点']
      .map((sheet) => XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets[sheet], { header: 1 }).flat().join('|'))
      .join('|');

    expect(html).toContain('X̄-S');
    expect(html).toContain('c₄σ̂');
    expect(html).toContain('未检出失控点');
    expect(workbookText).toContain('标准差');
    expect(workbookText).toContain('控制图无失控信号');
    expect(wordXml).toContain('X̄-S');
    expect(wordXml).toContain('未检出失控点');
    expect(slideXml).toContain('SPC 离散图（S）');
    expect(slideXml).toContain('未检出失控点');
  }, 30_000);

  it('保存、能力专项和通用四格式共用 pooled 计数，并回放固化方法；旧能力快照回落 classic', async () => {
    prepareCapability('xbar-r', 'pooled');
    useApp.setState({ page: 'capability' });
    const pooledPayload = buildActiveAnalysisReport()!;
    expect(pooledPayload.summary.join(' ')).not.toContain('过程不稳定');

    const pooledSaved = useAnalyses.getState().saveCurrent()!;
    expect(pooledSaved.snapshot.spcSigmaMethod).toBe('pooled');
    expect(pooledSaved.status).not.toContain('过程不稳定');
    useApp.setState({ spcSigmaMethod: 'classic' });
    await expect(useAnalyses.getState().restore(pooledSaved.id)).resolves.toBe(true);
    expect(useApp.getState().spcSigmaMethod).toBe('pooled');

    const legacy = structuredClone(pooledSaved);
    legacy.id = 'legacy-capability-sigma';
    delete legacy.snapshot.spcSigmaMethod;
    useAnalyses.setState({ saved: [legacy], lastError: null });
    useApp.setState({ spcSigmaMethod: 'pooled' });
    await expect(useAnalyses.getState().restore(legacy.id)).resolves.toBe(true);
    expect(useApp.getState().spcSigmaMethod).toBe('classic');

    prepareCapability('xbar-r', 'pooled');
    const { model, capabilityModel, spcFamily } = buildActiveAnalysisExport();
    const assessment = assessSpcCharts(model, onlyRule1, useApp.getState().spcRuleK, spcFamily);
    const capCount = countCapabilityViolations(capabilityModel, onlyRule1, useApp.getState().spcRuleK, 'xbar-r');
    expect(capCount).toBe(0);
    const jobs = await Promise.all((['pdf', 'excel', 'word', 'ppt'] as const).map((format) =>
      buildExportJob(format, model, spec, assessment, undefined, capabilityModel, capCount),
    ));
    expect(jobs[0].text).not.toContain('过程不稳定');
    const workbook = XLSX.read(jobs[1].bytes, { type: 'array' });
    const summary = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['统计摘要'], { header: 1 });
    expect(String(summary.find((entry) => entry[0] === '判定')?.[1])).not.toContain('过程不稳定');
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(jobs[2].bytes!), JSZip.loadAsync(jobs[3].bytes!)]);
    const wordXml = await docx.file('word/document.xml')!.async('string');
    const slideXml = (await Promise.all(Object.keys(pptx.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map((name) => pptx.file(name)!.async('string')))).join('\n');
    expect(wordXml).not.toContain('过程不稳定');
    expect(slideXml).not.toContain('过程不稳定');
  }, 30_000);

  it('X̄-R / X̄-S 的 pooled 离散 CL 标签按方法显示，classic 保持历史标签', () => {
    const raw = prepareCapability('xbar-r', 'pooled');
    expect(assessSpcCharts(withSigmaMethod(raw, 'pooled'), onlyRule1, useApp.getState().spcRuleK, 'xbar-r').dispersion.clLabel)
      .toBe('d₂σ̂');
    expect(assessSpcCharts(withSigmaMethod(raw, 'classic'), onlyRule1, useApp.getState().spcRuleK, 'xbar-r').dispersion.clLabel)
      .toBe('R̄');
    expect(assessSpcCharts(withSigmaMethod(raw, 'pooled'), onlyRule1, useApp.getState().spcRuleK, 'xbar-s').dispersion.clLabel)
      .toBe('c₄σ̂');
    expect(assessSpcCharts(withSigmaMethod(raw, 'classic'), onlyRule1, useApp.getState().spcRuleK, 'xbar-s').dispersion.clLabel)
      .toBe('S̄');
  });
});
