/**
 * 2026-09 全面审查第 3 批 G10-reportnum 回归:报告/图表数值失真 5 条。
 * 全部走真实生产链路(importMatrix → buildActiveAnalysisExport → 真实导出器),
 * 导出件解析回读后断言(HTML DOM / docx·pptx 解包 XML / SheetJS 读回单元格)。
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assessSpcCharts, computeCapability, computeGagePanelData, computeGageRR, countCapabilityViolations,
  CONTROL_CONSTANTS, DEFAULT_RULE_K, type GageObservation, type VarModel,
} from '../../core';
import { buildActiveAnalysisExport } from '../../platform/activeAnalysisReport';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { textReport } from '../../platform/report';
import { reportNum, reportSpecText, specLimitText } from '../../platform/reportLabels';
import { buildXlsx, xlsxTableCell } from '../../platform/xlsxExport';
import { DEFAULT_SPC_RULES, useApp, type Page } from '../../store/appStore';
import { useAnalyses } from '../../store/analyses';
import { rememberSpecForActiveMeasurement, useData } from '../../store/dataStore';
import {
  GageByOperatorPanel, GageByPartPanel, GageInteractionPanel, GageRPanel, GageReportFigure, GageXbarPanel,
  gageBarCategories,
} from '../charts/gagePanels';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [] });
  useApp.setState({
    page: 'dashboard', modal: null,
    spcType: 'xbar-r', spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    spcSigmaMethod: 'classic', spcRules: { ...DEFAULT_SPC_RULES }, spcRuleK: { ...DEFAULT_RULE_K },
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    capabilityWarningAcknowledgement: null,
  });
});

// ---------- 公共:四格式/五出口真实生成 + 回读 ----------

interface GenericExports {
  text: string;
  html: string;
  wordXml: string;
  slideXml: string;
  workbook: XLSX.WorkBook;
  model: VarModel;
  capabilityModel: VarModel;
}

async function buildGenericExports(spec: { lsl: number | null; tgt: number; usl: number | null }): Promise<GenericExports> {
  const { model, capabilityModel } = buildActiveAnalysisExport();
  const assessment = assessSpcCharts(model, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'xbar-r');
  const capCount = countCapabilityViolations(capabilityModel, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'xbar-r');
  const text = textReport(model, spec, assessment, capabilityModel, capCount);
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
  return { text, html, wordXml, slideXml, workbook, model, capabilityModel };
}

function htmlOverviewCells(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const heading = [...doc.querySelectorAll('h2')].find((node) => node.textContent?.startsWith('1. 过程概览'));
  const table = heading?.nextElementSibling as HTMLTableElement | null;
  return [...(table?.querySelectorAll('td.num') ?? [])].map((cell) => cell.textContent ?? '');
}

function sheetRows(workbook: XLSX.WorkBook, name: string): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1 });
}

const relClose = (actual: number, expected: number, rel: number) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * rel);
};

// ---------- PLATFORM-07:紧公差规格不得被 toFixed(2) 改写 ----------

describe('PLATFORM-07 通用报告规格限按用户输入原值展示，五出口同源', () => {
  const SPEC = { lsl: 9.995, tgt: 10, usl: 10.005 };

  function importTightTolerance() {
    // 25×5 子组,均值 10.000、σ≈0.0007(机加工 ±0.005 规格的日常量级)
    const rows = Array.from({ length: 25 }, (_, g) => (
      Array.from({ length: 5 }, (_, j) => Number((10 + (((g * 7 + j * 3) % 11) - 5) * 0.0002).toFixed(4)))
    ));
    useData.getState().importMatrix('紧公差.csv', ['m1', 'm2', 'm3', 'm4', 'm5'], rows);
    useApp.setState({ page: 'dashboard', lsl: SPEC.lsl, tgt: SPEC.tgt, usl: SPEC.usl, lslOn: true, uslOn: true });
  }

  it('HTML/Word/PPT/文本与 Excel 印同一组规格 9.995 / 10.00 / 10.005，不再出现 9.99 / 10.00 / 10.01', async () => {
    importTightTolerance();
    const out = await buildGenericExports(SPEC);
    const expectedText = '9.995 / 10.00 / 10.005';
    // HTML 过程概览第 4 个数值格就是规格
    expect(htmlOverviewCells(out.html)[3]).toBe(expectedText);
    for (const content of [out.text, out.html, out.wordXml, out.slideXml]) {
      expect(content).toContain(expectedText);
      expect(content).not.toContain('9.99 / 10.00 / 10.01');
    }
    expect(sheetRows(out.workbook, '统计摘要')).toContainEqual(['规格 LSL / 目标 / USL', expectedText]);
    // 报告上印的规格必须能复算出报告上的 Cpk(公差带 0.01 而非 0.02)
    const printed = expectedText.split(' / ').map(Number);
    const fromPrinted = computeCapability(out.capabilityModel.all, out.capabilityModel.sigmaWithin, {
      lsl: printed[0], tgt: printed[1], usl: printed[2],
    });
    const actual = computeCapability(out.capabilityModel.all, out.capabilityModel.sigmaWithin, SPEC);
    expect(fromPrinted.cp).toBeCloseTo(actual.cp!, 9);
  });

  it('微小规格/浮点残差/常规两位规格的唯一格式化口径', () => {
    expect(reportSpecText({ lsl: null, tgt: 0, usl: 0.002 })).toBe('无下限 / 0.00 / 0.002');
    expect(specLimitText(0.1 + 0.2)).toBe('0.30');
    expect(specLimitText(25)).toBe('25.00');
    expect(specLimitText(25.2)).toBe('25.20');
    expect(specLimitText(10.0005)).toBe('10.0005');
    expect(specLimitText(4.5e-9)).toBe('4.5e-9');
  });
});

// ---------- PLATFORM-14:小量级数据的报告数值不得归零 ----------

describe('PLATFORM-14 小量级数据报告数值按有效数字输出，Excel 写原始 double', () => {
  // 电容按 SI 单位记录:4.700e-9 ~ 4.706e-9 F,6 子组 × 5
  const CAP_SPEC = { lsl: 4.5e-9, tgt: 4.7e-9, usl: 4.9e-9 };
  function importCapacitors() {
    const rows = Array.from({ length: 6 }, (_, g) => (
      Array.from({ length: 5 }, (_, j) => Number(((4700 + ((g + j * 2) % 7)) * 1e-12).toPrecision(4)))
    ));
    useData.getState().importMatrix('电容.csv', ['m1', 'm2', 'm3', 'm4', 'm5'], rows);
    useApp.setState({ lsl: CAP_SPEC.lsl, tgt: CAP_SPEC.tgt, usl: CAP_SPEC.usl, lslOn: true, uslOn: true });
  }

  it('通用 HTML/Word/PPT/文本不再把均值/σ/控制限印成 0.0000,且解析回读与引擎值一致', async () => {
    importCapacitors();
    useApp.setState({ page: 'dashboard' });
    const out = await buildGenericExports(CAP_SPEC);
    const C = out.capabilityModel;
    const [mean, sigmaWithin, sigmaOverall] = htmlOverviewCells(out.html).slice(0, 3).map(Number);
    relClose(mean, C.oMean, 1e-3);
    relClose(sigmaWithin, C.sigmaWithin, 1e-3);
    relClose(sigmaOverall, C.oSd, 1e-3);
    for (const content of [out.wordXml, out.slideXml]) {
      expect(content).toContain(reportNum(C.oMean, 4));
      expect(content).toContain(reportNum(C.sigmaWithin, 4));
      expect(content).not.toContain('>0.0000<');
    }
    const limitLine = out.text.split('\n').find((line) => line.includes('中心线 X̄'))!;
    expect(limitLine).not.toMatch(/ 0\.000(?!\d)/);
    const ucl = Number(/UCL (\S+)/.exec(limitLine)![1]);
    relClose(ucl, out.model.uclX, 1e-3);
  });

  it('通用 Excel 统计摘要与数据 sheet 的均值/极差/σ 为原始数值(非数值 0)', async () => {
    importCapacitors();
    useApp.setState({ page: 'dashboard' });
    const out = await buildGenericExports(CAP_SPEC);
    const C = out.capabilityModel;
    const summary = sheetRows(out.workbook, '统计摘要');
    expect(summary.find((row) => row[0] === '能力口径均值')?.[1]).toBe(C.oMean);
    expect(summary.find((row) => String(row[0]).startsWith('σ 组内'))?.[1]).toBe(C.sigmaWithin);
    expect(summary.find((row) => row[0] === 'σ 整体')?.[1]).toBe(C.oSd);
    const data = sheetRows(out.workbook, '数据');
    const header = data[0] as string[];
    const first = data[1];
    expect(first[header.indexOf('均值')]).toBe(out.model.subs[0].mean);
    expect(first[header.indexOf('极差')]).toBe(out.model.subs[0].range);
    expect(first[header.indexOf('均值')]).not.toBe(0);
  });

  it('专项 SPC/能力报告的控制限、均值/σ 与原始观测不再整片 0.0000', () => {
    importCapacitors();
    useApp.setState({ page: 'spc' });
    const spc = buildActiveAnalysisExport();
    const limits = spc.report!.tables.find((table) => table.title.includes('控制限'))!;
    const xbarRow = limits.rows.find((row) => String(row[0]).startsWith('X̄'))!;
    for (const cell of xbarRow.slice(1, 4)) {
      expect(String(cell)).not.toMatch(/^-?0\.0+$/);
      relClose(Number(cell), spc.model.xbarbar, 1e-3);
    }
    const rawTable = spc.report!.tables.find((table) => table.title.includes('子组数据'))!;
    const rawCells = rawTable.rows.flatMap((row) => row.slice(1));
    expect(rawCells.some((cell) => /^0\.0+$/.test(String(cell)))).toBe(false);
    relClose(Number(rawCells[0]), spc.model.subs[0].vals[0], 1e-6);

    useApp.setState({ page: 'capability' });
    const capability = buildActiveAnalysisExport();
    const indices = capability.report!.tables.find((table) => table.title.includes('能力与性能指标'))!;
    const meanColumn = indices.headers.indexOf('均值');
    relClose(Number(indices.rows[0][meanColumn]), capability.capabilityModel.oMean, 1e-3);
  });

  it('常规量级与 0 的输出与 nf 逐字相同(既有报告形制不变)', () => {
    expect(reportNum(25.037051, 4)).toBe('25.0371');
    expect(reportNum(0, 4)).toBe('0.0000');
    expect(reportNum(0.0123, 4)).toBe('0.0123');
    expect(reportNum(0.00070833, 4)).toBe('0.0007083');
    expect(reportNum(4.7028333e-9, 4)).toBe('4.703e-9');
  });
});

// ---------- PLATFORM-15:专项 Excel 写数值单元格 ----------

describe('PLATFORM-15 专项 Excel 的统计量与原始观测是数值单元格(t=n)', () => {
  const NUMERIC_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]\d+)?$/i;

  for (const page of ['capability', 'spc', 'gagerr', 'summary'] as Page[]) {
    it(`${page} 专项:SheetJS 读回不存在「以文本形式存储的数字」`, () => {
      useApp.setState({ page });
      const { report, model, capabilityModel } = buildActiveAnalysisExport();
      expect(report).toBeDefined();
      const bytes = buildXlsx(model, { lsl: 24.9, tgt: 25, usl: 25.1 }, null, report, capabilityModel);
      const workbook = XLSX.read(bytes, { type: 'array', cellNF: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const cells = Object.entries(sheet).filter(([address]) => !address.startsWith('!')).map(([, cell]) => cell as XLSX.CellObject);
      const numericText = cells.filter((cell) => cell.t === 's' && NUMERIC_TEXT.test(String(cell.v)));
      expect(numericText.map((cell) => cell.v)).toEqual([]);
      expect(cells.filter((cell) => cell.t === 'n').length).toBeGreaterThan(10);
    });
  }

  it('能力专项原始观测读回为数值且保留 8 位显示格式', () => {
    useApp.setState({ page: 'capability' });
    const { report, model, capabilityModel } = buildActiveAnalysisExport();
    const table = report!.tables.find((entry) => entry.title.includes('子组数据'))!;
    const firstText = String(table.rows[0][1]);
    const workbook = XLSX.read(buildXlsx(model, { lsl: 24.9, tgt: 25, usl: 25.1 }, null, report, capabilityModel), { type: 'array', cellNF: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const match = Object.values(sheet).find((cell) => (cell as XLSX.CellObject).t === 'n' && (cell as XLSX.CellObject).v === Number(firstText)) as XLSX.CellObject | undefined;
    expect(match).toBeDefined();
    expect(match!.z).toBe('0.00000000');
    expect(Number(firstText)).toBeCloseTo(capabilityModel.subs[0].vals[0], 8);
  });

  it('标识符与超长编号保持文本，不被改写成数', () => {
    expect(xlsxTableCell('007')).toBe('007');
    expect(xlsxTableCell('12345678901234567890')).toBe('12345678901234567890');
    expect(xlsxTableCell('—')).toBe('—');
    expect(xlsxTableCell('25.0000')).toEqual({ t: 'n', v: 25, z: '0.0000' });
    expect(xlsxTableCell('4.703e-9')).toEqual({ t: 'n', v: 4.703e-9, z: '0.000E+00' });
    expect(xlsxTableCell('-0.0000')).toEqual({ t: 'n', v: 0, z: '0.0000' });
    // fmt(v,10) 的大量级原始观测(>15 位字符但带小数部分)同样写数值
    expect(xlsxTableCell('123456.1250000000')).toEqual({ t: 'n', v: 123456.125, z: '0.0000000000' });
  });
});

// ---------- UI-07:MSA 6 联图刻度/控制限标签 ----------

function svgTexts(markup: string): string[] {
  return [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
}
/** 纵轴刻度 = text-anchor="end" 的文本(panelFrame 唯一的右对齐文本)。 */
function tickTexts(markup: string): string[] {
  return [...markup.matchAll(/<text[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
}
function limitValue(texts: string[], prefix: string): string {
  const hit = texts.find((text) => text.startsWith(`${prefix}=`));
  expect(hit, `${prefix} 标签`).toBeDefined();
  return hit!.slice(prefix.length + 1);
}

function study(valueOf: (part: number, operator: number, trial: number) => number): GageObservation[] {
  const out: GageObservation[] = [];
  for (let part = 0; part < 10; part++) {
    for (let operator = 0; operator < 3; operator++) {
      for (let trial = 0; trial < 2; trial++) out.push({ part, operator, trial, value: valueOf(part, operator, trial) });
    }
  }
  return out;
}

function expectPanelsReadable(observations: GageObservation[]) {
  const panel = computeGagePanelData(observations, CONTROL_CONSTANTS[2]);
  const props = {
    T, panel, partLabels: Array.from({ length: 10 }, (_, index) => String(index + 1)), operatorLabels: ['甲', '乙', '丙'],
  };
  // 6 联图全部面板的纵轴刻度:两两可分、无负零
  const panels = [GageRPanel, GageXbarPanel, GageByPartPanel, GageByOperatorPanel, GageInteractionPanel];
  for (const Panel of panels) {
    const ticks = tickTexts(renderToStaticMarkup(createElement(Panel, props)));
    expect(ticks).toHaveLength(5);
    expect(new Set(ticks).size, `${Panel.name} 刻度 ${ticks.join(' ')}`).toBe(5);
    for (const tick of ticks) expect(tick).not.toMatch(/^-0(\.0*)?$/);
  }
  const figure = renderToStaticMarkup(createElement(GageReportFigure, {
    ...props, cats: gageBarCategories(computeGageRR(observations, null)), valueName: '测量',
  }));
  const texts = svgTexts(figure);
  const [ucls, lcls] = [texts.filter((text) => text.startsWith('UCL=')), texts.filter((text) => text.startsWith('LCL='))];
  expect(ucls).toHaveLength(2);
  const rBar = limitValue(texts, 'R̄');
  const xBar = limitValue(texts, 'X̿');
  // R 图:R̄ 不塌成 0,UCL 与 R̄ 可分,解析回读贴近真值
  expect(Number(rBar)).not.toBe(0);
  expect(Math.abs(Number(rBar) - panel.rLimits!.cl)).toBeLessThanOrEqual(panel.rLimits!.cl * 0.01);
  expect(ucls[0].slice(4)).not.toBe(rBar);
  // Xbar 图:UCL/X̿/LCL 三者两两可分,且各自回读贴近真值
  const xbarUcl = ucls[1].slice(4);
  const xbarLcl = lcls[lcls.length - 1].slice(4);
  expect(new Set([xbarUcl, xBar, xbarLcl]).size).toBe(3);
  const spread = panel.xbarLimits!.ucl - panel.xbarLimits!.lcl;
  expect(Math.abs(Number(xbarUcl) - panel.xbarLimits!.ucl)).toBeLessThanOrEqual(spread * 0.05);
  expect(Math.abs(Number(xBar) - panel.xbarLimits!.cl)).toBeLessThanOrEqual(spread * 0.05);
  expect(Math.abs(Number(xbarLcl) - panel.xbarLimits!.lcl)).toBeLessThanOrEqual(spread * 0.05);
  return { texts, panel };
}

describe('UI-07 MSA 6 联图刻度与控制限标签按间距/有效数字推位数', () => {
  it('小量纲 0.07±1e-4(分辨率 0.0001):UCL/X̿/LCL 可分、R̄≠0、刻度无重复与 -0.000', () => {
    const noise = [0, 1, -1, 2, 0, -2, 1, 0, -1, 1];
    expectPanelsReadable(study((part, operator, trial) => (
      Number((0.07 + (part - 5) * 0.0001 + ((noise[(part + operator * 3 + trial * 7) % 10]) * 0.0001)).toFixed(4))
    )));
  });

  it('大量纲(万级,span≥100 侧):R 图与 Xbar 图限值不再塌成同一个整数', () => {
    const noise = [0, 3, -2, 1, -4, 2, -1, 4, -3, 0];
    const { texts } = expectPanelsReadable(study((part, operator, trial) => (
      Number((25000 + part * 1500 + noise[(part * 3 + operator + trial * 5) % 10] * 0.1).toFixed(1))
    )));
    expect(texts.filter((text) => text.startsWith('LCL=')).some((text) => text === 'LCL=0')).toBe(true);
  });

  it('与工厂 Minitab 形制对拍:5 案例 30 个控制限标签 26 个逐字一致(4 个已知偏差如实钉住)', () => {
    const text = readFileSync(resolve(process.cwd(), 'src/core/__tests__/fixtures/gage-factory-cases-2026-07.tsv'), 'utf8');
    const cases = new Map<number, { observations: GageObservation[]; operators: string[] }>();
    const trialCounter = new Map<string, number>();
    for (const line of text.split(/\r?\n/).filter((row) => row && !row.startsWith('case'))) {
      const [caseText, partText, operatorText, valueText] = line.split('\t');
      const id = Number(caseText);
      const entry = cases.get(id) ?? { observations: [], operators: [] };
      cases.set(id, entry);
      if (!entry.operators.includes(operatorText)) entry.operators.push(operatorText);
      const operator = entry.operators.indexOf(operatorText);
      const part = Number(partText) - 1;
      const key = `${id}:${part}:${operator}`;
      const trial = trialCounter.get(key) ?? 0;
      trialCounter.set(key, trial + 1);
      entry.observations.push({ part, operator, trial, value: Number(valueText) });
    }
    // 工厂「MSA案例结果5个7.18.pptx」Minitab 17 EMF 图元逐记录提取的标签(R 图 UCL/R̄/LCL,Xbar 图 UCL/X̿/LCL)
    const MINITAB: Record<number, string[]> = {
      1: ['0.01030', '0.004', '0', '3.3188', '3.3147', '3.3106'],
      2: ['7.05', '2.74', '0', '63.5', '60.7', '57.9'],
      3: ['2.036', '0.791', '0', '74.224', '73.415', '72.606'],
      4: ['0.1716', '0.0667', '0', '0.844', '0.776', '0.708'],
      5: ['0.907', '0.352', '0', '25.372', '25.011', '24.651'],
    };
    // 已知偏差(如实记录):案例1 R̄ 本实现 0.00400(Minitab 去尾零 0.004);
    // 案例2 Xbar 本实现按「数据位数+1」印 2 位(63.48/60.68/57.87),Minitab 印 1 位。
    const KNOWN_DEVIATIONS: Record<string, string> = {
      '1:1': '0.00400', '2:3': '63.48', '2:4': '60.68', '2:5': '57.87',
    };
    let exact = 0;
    for (const [id, entry] of cases) {
      const trials = Math.max(...entry.observations.map((observation) => observation.trial)) + 1;
      const panel = computeGagePanelData(entry.observations, CONTROL_CONSTANTS[trials]);
      const figure = renderToStaticMarkup(createElement(GageReportFigure, {
        T, panel, partLabels: Array.from({ length: 10 }, (_, index) => String(index + 1)),
        operatorLabels: entry.operators, cats: gageBarCategories(computeGageRR(entry.observations, null)), valueName: 'Y',
      }));
      const texts = svgTexts(figure);
      const ucls = texts.filter((value) => value.startsWith('UCL=')).map((value) => value.slice(4));
      const lcls = texts.filter((value) => value.startsWith('LCL=')).map((value) => value.slice(4));
      const actual = [ucls[0], limitValue(texts, 'R̄'), lcls[0], ucls[1], limitValue(texts, 'X̿'), lcls[1]];
      actual.forEach((label, index) => {
        const deviation = KNOWN_DEVIATIONS[`${id}:${index}`];
        if (deviation) expect(label).toBe(deviation);
        else {
          expect(label, `案例${id} 第${index + 1}个限值标签`).toBe(MINITAB[id][index]);
          exact++;
        }
      });
    }
    expect(exact).toBe(26);
  });
});

// ---------- STORE-05:回看非能力类记录后规格按目标数据集恢复 ----------

describe('STORE-05 回看 ANOVA/DOE/描述性统计记录不得残留上一数据集的规格', () => {
  const B_VALUES = Array.from({ length: 30 }, (_, index) => 100 + ((index * 7) % 5) - 2);
  const A_VALUES = Array.from({ length: 30 }, (_, index) => 5 + ((index * 3) % 5) * 0.1);

  function importB(rememberSpec: boolean) {
    useData.getState().importMatrix('B.csv', ['直径'], B_VALUES.map((value) => [value]));
    const spec = { lsl: 90, usl: 110, tgt: 100, lslOn: true, uslOn: true };
    useApp.setState(spec);
    if (rememberSpec) {
      const { model, textCols } = useData.getState();
      rememberSpecForActiveMeasurement(model, textCols, spec);
    }
  }
  function switchToA() {
    useData.getState().importMatrix('A.csv', ['直径'], A_VALUES.map((value) => [value]));
    useApp.setState({ lsl: 1, usl: 9, tgt: 5, lslOn: true, uslOn: true });
  }
  const specOf = () => {
    const app = useApp.getState();
    return { lsl: app.lsl, usl: app.usl, tgt: app.tgt, lslOn: app.lslOn, uslOn: app.uslOn };
  };

  it('描述性统计记录回看后恢复 B 记忆的图纸规格(与 loadRecent 同口径)', async () => {
    importB(true);
    useApp.setState({ page: 'summary' });
    const record = useAnalyses.getState().saveCurrent();
    expect(record?.kind).toBe('summary');
    expect(record?.snapshot.lsl).toBeUndefined();
    switchToA();
    expect(await useAnalyses.getState().restore(record!.id)).toBe(true);
    expect(useData.getState().model.name).toBe('B.csv');
    expect(specOf()).toEqual({ lsl: 90, usl: 110, tgt: 100, lslOn: true, uslOn: true });
  });

  it('B 无规格记忆时按 B 的 μ±4σ 建议,不沿用 A 的 1/9/5', async () => {
    importB(false);
    useApp.setState({ page: 'summary' });
    const record = useAnalyses.getState().saveCurrent();
    switchToA();
    expect(await useAnalyses.getState().restore(record!.id)).toBe(true);
    const spec = specOf();
    expect(spec.lsl).not.toBe(1);
    expect(spec.usl).not.toBe(9);
    expect(spec.lsl).toBeLessThan(100);
    expect(spec.usl).toBeGreaterThan(100);
  });

  it('能力记录仍以快照固化的规格为准(不被规格记忆覆盖)', async () => {
    importB(true);
    useApp.setState({ page: 'capability', lsl: 92, usl: 108, tgt: 100 });
    const record = useAnalyses.getState().saveCurrent();
    expect(record?.snapshot.lsl).toBe(92);
    switchToA();
    expect(await useAnalyses.getState().restore(record!.id)).toBe(true);
    expect(specOf()).toMatchObject({ lsl: 92, usl: 108, tgt: 100 });
  });
});
