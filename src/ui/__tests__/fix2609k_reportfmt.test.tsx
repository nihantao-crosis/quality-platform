/** @vitest-environment jsdom */
/**
 * 2026-09 全面审查第 3 批复审 · G21-reportfmt 回归(报告/页面数值格式收口)。
 * (1) PLATFORM-07 残余:能力页「详细统计」与页头副标题的规格仍 nf(x,2);能力专项报告
 *     reportSpecDetailText 仍 toFixed(6)——微小规格全 0,与五种通用报告不同源。
 * (2) PLATFORM-14 残余:reportNum 只保证 2 位有效数字,4.7e-7/4.7e-9 数据的原始观测与描述统计
 *     仍被截成 "0.00000047";digits≤2 的常规值被改写(0.05→0.0500);DOE 浮点噪声印成 3.331e-16。
 * (3) UI-07 残余:MSA 控制图限值标签越过面板右缘被右列面板遮盖;R̄ 浮点噪声跨数量级;
 *     限值位数继承刻度保真循环;刻度非圆整导致 7~9 字符刻度。
 * (4) STORE-05 残余:gagerr 快照不含 tgt,回看切换数据集后 Target 沿用上一数据集;
 *     同名同内容回看误报「规格限未按该数据集恢复」;另存副本后按新内容的记忆恢复规格无提示。
 * 全部走真实生产函数(importMatrix → buildActiveAnalysisExport / 真实 SVG 组件 / restore)。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, render } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assessSpcCharts, computeGagePanelData, computeGageRR, countCapabilityViolations,
  CONTROL_CONSTANTS, DEFAULT_RULE_K, nf, type GageObservation,
} from '../../core';
import App from '../../App';
import { buildActiveAnalysisExport } from '../../platform/activeAnalysisReport';
import { buildHtmlReport } from '../../platform/htmlReport';
import { platform } from '../../platform/adapter';
import { textReport } from '../../platform/report';
import {
  reportNum, reportRawFormatter, reportSpecDetailText, reportSpecText, specLimitText,
} from '../../platform/reportLabels';
import { buildXlsx } from '../../platform/xlsxExport';
import { useAnalyses } from '../../store/analyses';
import { DEFAULT_SPC_RULES, useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, rememberSpecForActiveMeasurement, useData } from '../../store/dataStore';
import { GageReportFigure, gageBarCategories, gageLimitDecimals } from '../charts/gagePanels';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);

beforeEach(() => {
  cleanup();
  cancelPendingDatasetWork();
  platform.datasetDb = null;
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useAnalyses.setState({ saved: [], lastError: null });
  useApp.setState({
    page: 'dashboard', modal: null, toast: null, busyOverlay: null, openMenu: null, varOpen: false, selSub: null,
    spcType: 'xbar-r', spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    spcSigmaMethod: 'classic', spcRules: { ...DEFAULT_SPC_RULES }, spcRuleK: { ...DEFAULT_RULE_K },
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    capabilityWarningAcknowledgement: null, doeTab: 'analyze',
    gageUseReal: true, gageValueName: null, gagePartName: null, gageOperatorName: null,
  });
});
afterEach(() => {
  cleanup();
  cancelPendingDatasetWork();
});

// ============================================================ (1) PLATFORM-07 规格显示同源

describe('(1) PLATFORM-07 残余:能力页/页头/能力专项报告的规格与五种报告同源', () => {
  const TIGHT = { lsl: 9.995, tgt: 10, usl: 10.005 };
  function importTight() {
    const rows = Array.from({ length: 25 }, (_, g) => (
      Array.from({ length: 5 }, (_, j) => Number((10 + (((g * 7 + j * 3) % 11) - 5) * 0.0002).toFixed(4)))
    ));
    useData.getState().importMatrix('紧公差.csv', ['m1', 'm2', 'm3', 'm4', 'm5'], rows);
    useApp.setState({ ...TIGHT, lslOn: true, uslOn: true });
  }

  it('真实 <App/> 能力页:详细统计与页头副标题印 9.995 / 10.00 / 10.005(与通用报告同一串)', () => {
    importTight();
    useApp.setState({ page: 'capability' });
    const view = render(<App />);
    const text = view.container.textContent ?? '';
    const generic = reportSpecText(TIGHT);
    expect(generic).toBe('9.995 / 10.00 / 10.005');
    expect(text).toContain(generic);
    expect(text).not.toContain('9.99 / 10.00 / 10.01');
    // 页头副标题
    expect(text).toContain('规格 9.995–10.005');
    expect(text).not.toContain('规格 9.99–10.01');
  });

  it('真实 <App/> 能力页:单侧 USL=0.002 不再印成 0.00', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [Number((0.0005 + ((i * 7) % 10) * 0.00005).toFixed(5))]);
    useData.getState().importMatrix('平面度.csv', ['平面度'], rows);
    useApp.setState({ page: 'capability', spcDataLayout: 'individuals', spcValueCol: '平面度', lsl: 0, tgt: 0, usl: 0.002, lslOn: false, uslOn: true });
    const view = render(<App />);
    const text = view.container.textContent ?? '';
    expect(text).toContain('— / 0.00 / 0.002');
    expect(text).toContain('USL 0.002');
    expect(text).not.toContain('USL 0.00 ');
  });

  it('能力专项报告的规格行与通用报告数值一致;电容 4.5e-9 规格不再印成 LSL=0.000000', async () => {
    const CAP_SPEC = { lsl: 4.5e-9, tgt: 4.7e-9, usl: 4.9e-9 };
    const rows = Array.from({ length: 6 }, (_, g) => (
      Array.from({ length: 5 }, (_, j) => Number(((4700 + ((g + j * 2) % 7)) * 1e-12).toPrecision(4)))
    ));
    useData.getState().importMatrix('电容.csv', ['m1', 'm2', 'm3', 'm4', 'm5'], rows);
    useApp.setState({ ...CAP_SPEC, lslOn: true, uslOn: true, page: 'capability' });
    const { report, model, capabilityModel } = buildActiveAnalysisExport();
    const specLine = report!.summary.find((line) => line.startsWith('规格：'))!;
    expect(specLine).toContain('LSL=4.5e-9 / Target=4.7e-9 / USL=4.9e-9');
    expect(specLine).not.toContain('0.000000');
    // 与通用文本/HTML 报告的规格数值逐个相同
    const assessment = assessSpcCharts(model, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'xbar-r');
    const capCount = countCapabilityViolations(capabilityModel, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'xbar-r');
    const generic = reportSpecText(CAP_SPEC);
    expect(textReport(model, CAP_SPEC, assessment, capabilityModel, capCount)).toContain(generic);
    expect(buildHtmlReport(model, CAP_SPEC, assessment, undefined, capabilityModel, capCount)).toContain(generic);
    const genericNumbers = generic.split(' / ');
    const detailNumbers = /LSL=(\S+) \/ Target=(\S+) \/ USL=(\S+?)；/.exec(specLine)!.slice(1);
    expect(detailNumbers).toEqual(genericNumbers);
    // 常规紧公差:专项与通用同形制(不再是 9.995000)
    expect(reportSpecDetailText(TIGHT)).toBe('LSL=9.995 / Target=10.00 / USL=10.005');
    expect(reportSpecDetailText({ lsl: null, tgt: 0, usl: 1e-7 })).toBe('无下限 / Target=0.00 / USL=1e-7');
  });

  it('specLimitText 只去浮点残差,不改写 13 位以上有效数字的录入', () => {
    expect(specLimitText(0.1 + 0.2)).toBe('0.30');
    expect(specLimitText(99.9999999999999)).toBe('99.9999999999999');
    expect(specLimitText(1.23456789012345)).toBe('1.23456789012345');
    expect(specLimitText(25)).toBe('25.00');
    expect(specLimitText(4.5e-9)).toBe('4.5e-9');
  });
});

// ============================================================ (2) PLATFORM-14 小量级/噪声

function smallData(scale: number, k = 8) {
  // 4.700~4.706 × scale,4 位有效数字(电容/形位误差的 SI 记录)
  return Array.from({ length: k }, (_, g) => (
    Array.from({ length: 5 }, (_, j) => Number(((4700 + ((g * 3 + j * 2) % 7)) * scale * 1e-3).toPrecision(4)))
  ));
}

describe('(2) PLATFORM-14 残余:原始观测全精度、统计量阈值 3 位有效数字、噪声与 digits≤2 不改写', () => {
  it('reportNum:10^(1−d)~10^(3−d) 区间不再截到 2 位有效数字;常规量级与 digits≤2 逐字不变', () => {
    expect(reportNum(4.70262e-7, 8)).toBe('4.70262e-7');
    expect(reportNum(4.70262e-9, 10)).toBe('4.70262e-9');
    // 常规量级与既有形制逐字相同
    expect(reportNum(25.037051, 4)).toBe('25.0371');
    expect(reportNum(0.0123, 4)).toBe('0.0123');
    expect(reportNum(0, 4)).toBe('0.0000');
    expect(reportNum(12.5, 1)).toBe('12.5');
    // digits ≤ 2(α、百分比)不被改写成 0.0500 / 0.500
    expect(reportNum(0.05, 2)).toBe('0.05');
    expect(reportNum(0.5, 1)).toBe('0.5');
    expect(reportNum(0.01, 2)).toBe('0.01');
    // 相对数据尺度的浮点噪声按 0 输出
    expect(reportNum(3.3306690738754696e-16, 4, 300)).toBe('0.0000');
    expect(reportNum(-1.6653345369377348e-16, 4, 300)).toBe('0.0000');
    // 同一数值在小尺度数据里是真实量,不被当成噪声
    expect(reportNum(3.3e-16, 4, 1e-12)).toBe('3.300e-16');
  });

  it('原始观测格式化:常规数据与 nf(v,8) 逐字相同;定点截断的小量级整表改全精度', () => {
    const regular = [25.1, 24.987, 25.0123, 0.1 + 0.2];
    const format = reportRawFormatter(regular);
    expect(regular.map(format)).toEqual(regular.map((value) => nf(value, 8)));
    const small = [4.7e-7, 4.703e-7, 4.706e-7];
    expect(small.map(reportRawFormatter(small))).toEqual(['4.7e-7', '4.703e-7', '4.706e-7']);
    const tiny = [4.7e-9, 4.702e-9];
    expect(tiny.map(reportRawFormatter(tiny, 10))).toEqual(['4.7e-9', '4.702e-9']);
  });

  for (const [label, scale] of [['4.7e-7', 1e-7], ['4.7e-9', 1e-9]] as const) {
    it(`SPC/能力专项原始子组表(${label}):每格回读等于原始观测,Excel 单元格存原始 double`, () => {
      const rows = smallData(scale);
      useData.getState().importMatrix(`小量级${label}.csv`, ['m1', 'm2', 'm3', 'm4', 'm5'], rows);
      for (const page of ['spc', 'capability'] as const) {
        useApp.setState({ page, lsl: 4.5 * scale, tgt: 4.7 * scale, usl: 4.9 * scale, lslOn: true, uslOn: true });
        const { report, model, capabilityModel } = buildActiveAnalysisExport();
        const raw = report!.tables.find((table) => table.title.includes('子组数据'))!;
        raw.rows.forEach((row, index) => {
          expect(row.slice(1).map(Number), `${page} 第${index + 1}行`).toEqual(rows[index]);
        });
        const workbook = XLSX.read(buildXlsx(model, { lsl: 4.5 * scale, tgt: 4.7 * scale, usl: 4.9 * scale }, null, report, capabilityModel), { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const numeric = new Set(Object.values(sheet).filter((cell) => (cell as XLSX.CellObject).t === 'n').map((cell) => (cell as XLSX.CellObject).v));
        for (const value of rows.flat()) expect(numeric.has(value), `${page} Excel 缺少原始值 ${value}`).toBe(true);
      }
    });
  }

  it('描述统计专项(4.7e-7):统计量表与 summary 句同源,不再是 "0.00000047";原始观测全精度', () => {
    const values = smallData(1e-7).flat();
    useData.getState().importMatrix('小量级单列.csv', ['电容'], values.map((value) => [value]));
    useApp.setState({ page: 'summary', activeVar: '电容' });
    const { report } = buildActiveAnalysisExport();
    const stats = report!.tables.find((table) => table.title === '描述性统计量')!;
    const [meanCell, , , minCell] = stats.rows[0].slice(2).map(String);
    expect(meanCell).not.toBe('0.00000047');
    expect(minCell).not.toMatch(/^0\.0000004\d$/);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(Math.abs(Number(meanCell) - mean)).toBeLessThanOrEqual(mean * 1e-5);
    expect(report!.summary[0]).toContain(`均值 ${meanCell}`);
    const raw = report!.tables.find((table) => table.title === '用于汇总的原始观测')!;
    expect(raw.rows.map((row) => Number(row[1]))).toEqual(values);
  });

  it('常规量级回归:演示数据的专项原始观测/统计量表与修复前 nf 形制逐字相同', () => {
    useApp.setState({ page: 'capability' });
    const capability = buildActiveAnalysisExport();
    const raw = capability.report!.tables.find((table) => table.title.includes('子组数据'))!;
    raw.rows.forEach((row, index) => {
      expect(row.slice(1)).toEqual(capability.capabilityModel.subs[index].vals.map((value) => nf(value, 8)));
    });
    useApp.setState({ page: 'spc' });
    const spc = buildActiveAnalysisExport();
    const limits = spc.report!.tables.find((table) => table.title.includes('控制限'))!;
    const xbar = limits.rows.find((row) => String(row[0]).startsWith('X̄'))!;
    expect(xbar.slice(1, 4)).toEqual([nf(spc.model.xbarbar, 4), nf(spc.model.uclX, 4), nf(spc.model.lclX, 4)]);
  });

  it('演示 DOE「效应与系数」:A×B 的浮点噪声按 0.0000 输出,不印成 3.331e-16', () => {
    useApp.setState({ page: 'doe', doeTab: 'analyze' });
    const { report } = buildActiveAnalysisExport();
    const table = report!.tables.find((entry) => entry.title === '效应与系数')!;
    const cells = table.rows.flatMap((row) => row.slice(1, 3).map(String));
    expect(cells.filter((cell) => /e-1\d/.test(cell))).toEqual([]);
    expect(cells).toContain('0.0000');
  });
});

// ============================================================ (3) UI-07 MSA 图几何与位数

function study(valueOf: (part: number, operator: number, trial: number) => number, operators = 3): GageObservation[] {
  const out: GageObservation[] = [];
  for (let part = 0; part < 10; part++) {
    for (let operator = 0; operator < operators; operator++) {
      for (let trial = 0; trial < 2; trial++) out.push({ part, operator, trial, value: valueOf(part, operator, trial) });
    }
  }
  return out;
}

interface SvgText { x: number; text: string; anchor: string }
function svgTextNodes(markup: string): SvgText[] {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  return [...doc.querySelectorAll('text')].map((node) => ({
    x: Number(node.getAttribute('x')), text: node.textContent ?? '', anchor: node.getAttribute('text-anchor') ?? 'start',
  }));
}
function figureMarkup(observations: GageObservation[], operators: string[]) {
  const panel = computeGagePanelData(observations, CONTROL_CONSTANTS[2]);
  return renderToStaticMarkup(createElement(GageReportFigure, {
    T, panel, partLabels: Array.from({ length: 10 }, (_, index) => String(index + 1)), operatorLabels: operators,
    cats: gageBarCategories(computeGageRR(observations, null)), valueName: '测量',
  }));
}
const LIMIT_LABEL = /^(UCL|LCL|R̄|X̿)=/;
/** 独立口径的可见字符数(组合上横线不占字宽),不复用被测模块的实现。 */
const visibleChars = (text: string) => Array.from(text.replace(/[\u0300-\u036f]/g, '')).length;
const PW = 560;
const CELL_GAP = 8;

const NOISE = [0, 1, -1, 2, 0, -2, 1, 0, -1, 1];
const BIG_NOISE = [0, 3, -2, 1, -4, 2, -1, 4, -3, 0];
const CASES: Array<[string, (part: number, operator: number, trial: number) => number]> = [
  ['小量纲 0.07±1e-4', (p, o, t) => Number((0.07 + (p - 5) * 0.0001 + NOISE[(p + o * 3 + t * 7) % 10] * 0.0001).toFixed(4))],
  ['百万级 1234580', (p, o, t) => Number((1234580 + BIG_NOISE[(p * 3 + o + t * 5) % 10] * 0.3).toFixed(1))],
  ['偏差数据(负 LCL)', (p, o, t) => Number(((p - 4.5) * 0.0004 + NOISE[(p * 7 + o * 3 + t) % 10] * 0.0009).toFixed(4))],
];

describe('(3) UI-07 残余:限值标签不越过面板右缘;位数不随浮点噪声/刻度保真漂移;刻度圆整', () => {
  for (const [label, valueOf] of CASES) {
    it(`${label}:6 联图左列与 4 联图右列的每个限值标签 x+字符数×0.6×9 ≤ 面板宽`, () => {
      const layouts: Array<[string, number, string[]]> = [['6 联图', 3, ['甲', '乙', '丙']], ['4 联图', 1, ['甲']]];
      for (const [layout, operatorCount, operators] of layouts) {
        const labels = svgTextNodes(figureMarkup(study(valueOf, operatorCount), operators)).filter((node) => LIMIT_LABEL.test(node.text));
        expect(labels.length, layout).toBeGreaterThanOrEqual(5);
        for (const node of labels) {
          const right = node.x + visibleChars(node.text) * 0.6 * 9;
          expect(right, `${layout} ${node.text}`).toBeLessThanOrEqual(PW + CELL_GAP);
          expect(right, `${layout} ${node.text} 不出本面板`).toBeLessThanOrEqual(PW);
        }
      }
    });
  }

  it('镜像数据(R̄ 数学上同为 1e-4,一组算成 9.99…e-5):两组限值标签逐字相同', () => {
    const labelsOf = (sign: number) => svgTextNodes(figureMarkup(study((p, o, t) => (
      Number((0.93 + sign * ((p - 5) * 0.0001 + NOISE[(p + o * 3 + t * 7) % 10] * 0.0001)).toFixed(4))
    )), ['甲', '乙', '丙'])).filter((node) => /^(UCL|R̄)=/.test(node.text)).map((node) => node.text);
    const positive = labelsOf(1);
    const negative = labelsOf(-1);
    expect(positive.slice(0, 2)).toEqual(negative.slice(0, 2));
    expect(positive).toContain('R̄=0.000100');
  });

  it('限值位数只取 gageLimitDecimals(Minitab 规则),不继承刻度保真循环升出的位数', () => {
    const observations = study((p, o, t) => (
      Number((0.3778 + (p - 5) * 0.00004 + NOISE[(p * 3 + o + t * 7) % 10] * 0.00003).toFixed(5))
    ));
    const panel = computeGagePanelData(observations, CONTROL_CONSTANTS[2]);
    const texts = svgTextNodes(figureMarkup(observations, ['甲', '乙', '丙'])).map((node) => node.text);
    // 数据 5 位小数 → dataDecimals 上限 3 位;Xbar 角色位数 = 3+1,R 角色 = 3(axisSpan 只作噪声门,取 1 即可)
    const xbarDp = gageLimitDecimals(panel.xbarLimits!, 1, 4);
    const rDp = gageLimitDecimals(panel.rLimits!, 1, 3);
    const xbar = texts.filter((text) => /^(UCL|X̿|LCL)=0\.3/.test(text));
    expect(xbar).toHaveLength(3);
    for (const text of xbar) expect(text.split('.')[1], text).toHaveLength(xbarDp);
    const rLabels = texts.filter((text) => /^(UCL|R̄)=0\.0/.test(text));
    expect(rLabels).toHaveLength(2);
    for (const text of rLabels) expect(text.split('.')[1], text).toHaveLength(rDp);
  });

  it('纵轴刻度落在 1-2-5 圆整位置;刻度文本左端不压旋转的 y 轴标题', () => {
    for (const [label, valueOf] of CASES) {
      const doc = new DOMParser().parseFromString(figureMarkup(study(valueOf), ['甲', '乙', '丙']), 'image/svg+xml');
      const panels = [...doc.documentElement.children].filter((node) => node.tagName === 'g');
      expect(panels, label).toHaveLength(6);
      for (const [index, panel] of panels.entries()) {
        const texts = [...panel.querySelectorAll('text')];
        const ticks = texts.filter((node) => node.getAttribute('text-anchor') === 'end');
        const values = ticks.map((node) => Number(node.textContent));
        expect(values.length, `${label} 面板${index + 1}`).toBeGreaterThanOrEqual(3);
        // 相邻刻度等距,步长 = {1,2,5}×10^k,且每个刻度是步长的整数倍
        const rawStep = Math.abs(values[1] - values[0]);
        const power = 10 ** Math.floor(Math.log10(rawStep) + 1e-9);
        const nice = [1, 2, 5].find((candidate) => Math.abs(rawStep / power - candidate) < 1e-6);
        expect(nice, `${label} 面板${index + 1} 步长 ${rawStep}`).toBeDefined();
        const step = nice! * power;
        for (const value of values) {
          expect(Math.abs(value - Math.round(value / step) * step), `${label} 面板${index + 1} 刻度 ${value}`).toBeLessThan(step * 1e-3);
        }
        // 有 y 轴标题(旋转 text,x=14)的面板:刻度文本左端 ≥ 20
        if (texts.some((node) => (node.getAttribute('transform') ?? '').startsWith('rotate'))) {
          for (const tick of ticks) {
            const leftEdge = Number(tick.getAttribute('x')) - visibleChars(tick.textContent ?? '') * 0.6 * 9;
            expect(leftEdge, `${label} 面板${index + 1} 刻度 ${tick.textContent}`).toBeGreaterThanOrEqual(20);
          }
        }
      }
    }
  });
});

// ============================================================ (4) STORE-05 量具记录的 Target

describe('(4) STORE-05 残余:量具记录回看后 Target 取目标数据集,提示只在真的切换数据集时出现', () => {
  const G_ROWS = Array.from({ length: 20 }, (_, index) => [Number((20 + ((index * 7) % 9 - 4) * 0.01).toFixed(2))]);
  const G_TEXT = [
    { name: '部件', values: Array.from({ length: 20 }, (_, index) => `P${Math.floor(index / 4) + 1}`) },
    { name: '操作员', values: Array.from({ length: 20 }, (_, index) => `O${Math.floor(index / 2) % 2 + 1}`) },
  ];
  function importG(memory: { lsl: number; usl: number; tgt: number } | null) {
    useData.getState().importMatrix('G.csv', ['测量值'], G_ROWS, G_TEXT);
    const spec = { lsl: 19.9, usl: 20.1, tgt: 20, lslOn: true, uslOn: true };
    useApp.setState({ ...spec, page: 'gagerr', gageUseReal: true, gageValueName: '测量值', gagePartName: '部件', gageOperatorName: '操作员' });
    if (memory) {
      const { model, textCols } = useData.getState();
      rememberSpecForActiveMeasurement(model, textCols, { ...memory, lslOn: true, uslOn: true });
    }
  }
  function switchToA() {
    useData.getState().importMatrix('A.csv', ['直径'], Array.from({ length: 30 }, (_, index) => [5 + ((index * 3) % 5) * 0.1]));
    useApp.setState({ lsl: 1, usl: 9, tgt: 5, lslOn: true, uslOn: true, page: 'dashboard' });
  }

  it('回看量具记录:lsl/usl 取快照,Target 等于 G 的规格记忆(不沿用 A 的 5)', async () => {
    importG({ lsl: 19.9, usl: 20.1, tgt: 20 });
    const record = useAnalyses.getState().saveCurrent();
    expect(record?.kind).toBe('gagerr');
    expect(record?.snapshot.tgt).toBeUndefined();
    switchToA();
    expect(await useAnalyses.getState().restore(record!.id)).toBe(true);
    expect(useData.getState().model.name).toBe('G.csv');
    expect(useApp.getState()).toMatchObject({ lsl: 19.9, usl: 20.1, tgt: 20, lslOn: true, uslOn: true });
  });

  it('G 的规格记忆与快照规格不一致(记忆 Target 落在快照区间外)时取快照区间中点', async () => {
    importG(null);
    const record = useAnalyses.getState().saveCurrent();
    // 快照之后 G 的规格记忆被改成另一组图纸值
    const { model, textCols } = useData.getState();
    rememberSpecForActiveMeasurement(model, textCols, { lsl: 30, usl: 40, tgt: 35, lslOn: true, uslOn: true });
    switchToA();
    expect(await useAnalyses.getState().restore(record!.id)).toBe(true);
    const app = useApp.getState();
    expect(app.lsl).toBe(19.9);
    expect(app.usl).toBe(20.1);
    expect(app.tgt).toBeCloseTo(20, 12);
  });

  it('同一宽表回看自己的描述统计记录不误报「规格限未按该数据集恢复」;真的换了数据集仍提示', async () => {
    const W_ROWS = Array.from({ length: 12 }, (_, index) => [20 + index * 0.01, 5 + index * 0.01]);
    useData.getState().importMatrix('W.csv', ['长度', '宽度'], W_ROWS);
    useApp.setState({ page: 'summary', activeVar: '长度', toast: null });
    const record = useAnalyses.getState().saveCurrent();
    expect(record?.kind).toBe('summary');
    await act(async () => { expect(await useAnalyses.getState().restore(record!.id)).toBe(true); });
    expect(useApp.getState().toast ?? '').not.toContain('规格限未按该数据集恢复');

    switchToA();
    useApp.setState({ toast: null });
    await act(async () => { expect(await useAnalyses.getState().restore(record!.id)).toBe(true); });
    expect(useData.getState().model.name).toBe('W.csv');
    expect(useApp.getState().toast ?? '').toContain('规格限未按该数据集恢复');
  });

  it('同名数据集在快照后被改(已另存副本)时,按当前记忆恢复规格并提示核对', async () => {
    const B_ROWS = Array.from({ length: 30 }, (_, index) => [20 + ((index * 7) % 5 - 2) * 0.01]);
    useData.getState().importMatrix('B.csv', ['直径'], B_ROWS);
    useApp.setState({ page: 'summary', activeVar: '直径' });
    const record = useAnalyses.getState().saveCurrent();
    // 快照之后同名 B 被改写并记了新规格
    useData.getState().importMatrix('B.csv', ['直径'], B_ROWS.map(([value]) => [value + 0.3]));
    const { model, textCols } = useData.getState();
    rememberSpecForActiveMeasurement(model, textCols, { lsl: 20.2, usl: 20.4, tgt: 20.3, lslOn: true, uslOn: true });
    useApp.setState({ toast: null });
    await act(async () => { expect(await useAnalyses.getState().restore(record!.id)).toBe(true); });
    const toast = useApp.getState().toast ?? '';
    expect(toast).toContain('另存');
    expect(toast).toContain('请在过程能力页核对 LSL/USL');
  });
});
