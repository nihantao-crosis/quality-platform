/** @vitest-environment jsdom */
/**
 * fix2611a G25c-export C2(附录 F.2-6):通用导出的 SPC 判异明细在源头有界。
 * - assessSpcCharts(…, { eventDetailLimit }) 只物化按 (点号, 图, 准则) 排序的前 N 条明细;
 * - 计数(各图点数/去重分析单元/点×准则总命中/各图命中/结论行)与全量路径逐一相等;
 * - 四种导出(HTML/Word/PPT/Excel)用有界结果与用全量结果的输出逐字相同(各格式既有上限与截断说明不变);
 * - 导出弹窗(Modals)走有界通道。
 */
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  assessSpcCharts, computeVarModel, DEFAULT_RULE_K, type NelsonRules, type SpcAssessment,
} from '../../core';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { platform, type ExportJob } from '../../platform/adapter';
import { MAX_XLSX_VIOLATION_ROWS } from '../../platform/reportLabels';
import { textReport } from '../../platform/report';
import { buildXlsx } from '../../platform/xlsxExport';
import App from '../../App';
import { DEFAULT_SPC_RULES, useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';

const ALL: NelsonRules = { r1: true, r2: true, r3: true, r4: true, r5: true, r6: true, r7: true, r8: true };
const SPEC = { lsl: 8, tgt: 10, usl: 12 };

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** 自相关 + 慢漂移,三位小数:与 fix2609c_perf 同形态的高命中数据。 */
function driftSeries(count: number, seed: number): number[] {
  const random = lcg(seed);
  let level = 0;
  return Array.from({ length: count }, (_, index) => {
    level = 0.92 * level + (random() - 0.5);
    return Math.round((10 + level + Math.sin(index / 5000) * 0.8) * 1000) / 1000;
  });
}

type Bounded = SpcAssessment;
const assessBounded = assessSpcCharts;

function expectSameCounts(bounded: Bounded, full: SpcAssessment) {
  expect(bounded.chartPointCount).toBe(full.chartPointCount);
  expect(bounded.locationPoints).toBe(full.locationPoints);
  expect(bounded.dispersionPoints).toBe(full.dispersionPoints);
  expect(bounded.uniqueAnalysisUnitCount).toBe(full.uniqueAnalysisUnitCount);
  expect(bounded.stable).toBe(full.stable);
  expect(bounded.verdictLine).toBe(full.verdictLine);
  expect(bounded.unavailableReason ?? null).toBe(full.unavailableReason ?? null);
  expect([...bounded.locationViolIndexes]).toEqual([...full.locationViolIndexes]);
  expect([...bounded.dispersionViolIndexes]).toEqual([...full.dispersionViolIndexes]);
  // 总命中数/各准则计数与全量明细逐一相等
  expect(bounded.eventTotal).toBe(full.events.length);
  const counts = (chart: string) => {
    const byRule: Record<number, number> = {};
    let total = 0;
    for (const event of full.events) {
      if (event.chart !== chart) continue;
      total++;
      byRule[event.rule] = (byRule[event.rule] ?? 0) + 1;
    }
    return { total, byRule };
  };
  const b = bounded;
  expect(b.locationEventCounts).toEqual(counts(full.locationLabel));
  expect(b.dispersionEventCounts).toEqual(counts(full.dispersionLabel));
}

describe('C2 · assessSpcCharts 有界明细通道', () => {
  it('20 万点高命中 I-MR:明细数组有界、前缀与全量逐条相同、计数逐一相等', () => {
    const values = driftSeries(200_000, 20261114);
    const M = computeVarModel('drift-200k.csv', ['值'], values.map((v) => [v]));
    const full = assessSpcCharts(M, ALL, DEFAULT_RULE_K, 'i-mr');
    expect(full.events.length).toBeGreaterThan(MAX_XLSX_VIOLATION_ROWS * 5);
    const bounded = assessBounded(M, ALL, DEFAULT_RULE_K, 'i-mr', null, { eventDetailLimit: MAX_XLSX_VIOLATION_ROWS });
    expect(bounded.events.length).toBe(MAX_XLSX_VIOLATION_ROWS);
    expect(bounded.eventsTruncated).toBe(true);
    expect(bounded.events).toEqual(full.events.slice(0, MAX_XLSX_VIOLATION_ROWS));
    expectSameCounts(bounded, full);
  }, 120_000);

  it('X̄-R / X̄-S / 分阶段 / 自定义 K:有界与全量计数相等、前缀相同;未截断时明细完全相同', () => {
    const values = driftSeries(5_000, 7);
    const rows = Array.from({ length: 1_000 }, (_, i) => values.slice(i * 5, i * 5 + 5));
    const M = computeVarModel('sub.csv', ['a', 'b', 'c', 'd', 'e'], rows);
    const labels = rows.map((_, i) => (i < 400 ? 'A' : i < 700 ? 'B' : 'C'));
    const stage = { state: 'active' as const, column: '阶段', labels };
    const customK = { ...DEFAULT_RULE_K, k2: 7, k3: 5, k7: 12 };
    const cases: Array<[string, Parameters<typeof assessSpcCharts>]> = [
      ['xbar-r', [M, ALL, DEFAULT_RULE_K, 'xbar-r']],
      ['xbar-s', [M, ALL, DEFAULT_RULE_K, 'xbar-s']],
      ['staged', [M, ALL, DEFAULT_RULE_K, 'xbar-r', stage]],
      ['custom-k', [M, ALL, customK, 'i-mr']],
    ];
    for (const [name, args] of cases) {
      const full = assessSpcCharts(...args);
      for (const limit of [0, 7, 500, 1_000_000]) {
        const bounded = assessBounded(args[0], args[1], args[2], args[3], args[4] ?? null, { eventDetailLimit: limit });
        expect(bounded.events, `${name}/${limit}`).toEqual(full.events.slice(0, limit));
        expect(bounded.eventsTruncated, `${name}/${limit}`).toBe(full.events.length > limit);
        expectSameCounts(bounded, full);
      }
    }
  }, 60_000);

  it('全量模式(不传上限)的返回形制与 HEAD 一致:events 为完整明细、eventTotal=events.length', () => {
    const M = computeVarModel('s.csv', ['值'], driftSeries(400, 3).map((v) => [v]));
    const full = assessSpcCharts(M, ALL, DEFAULT_RULE_K, 'i-mr') as Bounded;
    expect(full.eventTotal).toBe(full.events.length);
    expect(full.eventsTruncated).toBe(false);
  });
});

async function officeXml(bytes: Uint8Array, kind: 'docx' | 'pptx'): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((name) => (kind === 'docx' ? name === 'word/document.xml' : /^ppt\/slides\/slide\d+\.xml$/.test(name)))
    .sort();
  return (await Promise.all(names.map((name) => zip.file(name)!.async('string')))).join('\n');
}

describe('C2 · 四种导出用有界结果与全量结果逐字相同', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T08:00:00Z'));
  });
  afterAll(() => { vi.useRealTimers(); });

  it('3 万点高命中(明细 > 2 万条):HTML/Word/PPT/Excel 输出与全量路径相同,截断说明写全量总数', async () => {
    const values = driftSeries(30_000, 99);
    const M = computeVarModel('drift-30k.csv', ['值'], values.map((v) => [v]));
    const full = assessSpcCharts(M, ALL, DEFAULT_RULE_K, 'i-mr');
    expect(full.events.length).toBeGreaterThan(MAX_XLSX_VIOLATION_ROWS);
    const bounded = assessBounded(M, ALL, DEFAULT_RULE_K, 'i-mr', null, { eventDetailLimit: MAX_XLSX_VIOLATION_ROWS });
    expect(bounded.events.length).toBe(MAX_XLSX_VIOLATION_ROWS);

    expect(buildHtmlReport(M, SPEC, bounded)).toBe(buildHtmlReport(M, SPEC, full));
    const sheets = (assessment: SpcAssessment) => {
      const wb = XLSX.read(buildXlsx(M, SPEC, assessment), { type: 'array' });
      return wb.SheetNames.map((name) => [name, XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false })]);
    };
    const boundedSheets = sheets(bounded);
    expect(boundedSheets).toEqual(sheets(full));
    const violations = boundedSheets.find(([name]) => name === '失控点')![1] as string[][];
    expect(violations.length).toBe(MAX_XLSX_VIOLATION_ROWS + 2);
    expect(violations[violations.length - 1].join('')).toContain(`共 ${full.events.length} 条判异事件`);
    expect(await officeXml(await buildDocx(M, SPEC, {}, bounded), 'docx'))
      .toBe(await officeXml(await buildDocx(M, SPEC, {}, full), 'docx'));
    expect(await officeXml(await buildPptx(M, SPEC, {}, bounded), 'pptx'))
      .toBe(await officeXml(await buildPptx(M, SPEC, {}, full), 'pptx'));
    // 纯文本报告:有界时明细只列前缀,并以与 Excel 同一形制写明全量总数
    const text = textReport(M, SPEC, bounded);
    expect(text).toContain(`共 ${full.events.length} 条判异事件`);
    expect(text.split('\n').filter((line) => line.startsWith('    · '))).toHaveLength(MAX_XLSX_VIOLATION_ROWS);
  }, 120_000);

  it('PPT 每图明细:位置图命中占满全局前缀时,离散图仍列自身前 8 条且「该图共 N 项」与全量一致', async () => {
    // 整数斜坡:MR 恒为 1(MR 图无命中),I 图几乎每点多准则命中;末尾跳变只让 MR 图命中。
    // 全局前 2 万条明细因此全是 I 图,MR 图明细只在全量序列末尾。
    const values = Array.from({ length: 25_000 }, (_, i) => i);
    values.push(30_000, 25_000, 30_000, 25_000, 30_000);
    // 只启用准则 1/3:MR 恒为 1 时既不超限也无趋势(准则 2 会因 MR̄ 被跳变抬高而全线命中)
    const rules: NelsonRules = { ...ALL, r2: false, r4: false, r5: false, r6: false, r7: false, r8: false };
    const M = computeVarModel('late-mr.csv', ['值'], values.map((v) => [v]));
    const full = assessSpcCharts(M, rules, DEFAULT_RULE_K, 'i-mr');
    const bounded = assessBounded(M, rules, DEFAULT_RULE_K, 'i-mr', null, { eventDetailLimit: MAX_XLSX_VIOLATION_ROWS });
    expect(full.events.length).toBeGreaterThan(MAX_XLSX_VIOLATION_ROWS);
    const mrInPrefix = bounded.events.filter((event) => event.chart === 'MR').length;
    const mrInFull = full.events.filter((event) => event.chart === 'MR').length;
    expect(mrInPrefix).toBe(0);
    expect(mrInFull).toBeGreaterThan(0);
    expect(await officeXml(await buildPptx(M, SPEC, {}, bounded), 'pptx'))
      .toBe(await officeXml(await buildPptx(M, SPEC, {}, full), 'pptx'));
  }, 120_000);
});

describe('C2 · 导出弹窗走有界通道', () => {
  beforeEach(() => {
    localStorage.clear();
    useData.getState().resetDemo();
    useApp.setState({
      page: 'dashboard', modal: null, exportFmt: 'excel',
      spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null, spcSigmaMethod: 'classic',
      spcType: 'i-mr', capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
      spcRules: { ...DEFAULT_SPC_RULES, ...ALL }, spcRuleK: DEFAULT_RULE_K,
      lsl: SPEC.lsl, tgt: SPEC.tgt, usl: SPEC.usl, lslOn: true, uslOn: true,
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('Excel 失控点页:行数有界、截断说明写全量总数,总数与全量评估相同', async () => {
    const values = driftSeries(30_000, 42);
    useData.getState().importMatrix('drift.csv', ['值'], values.map((v) => [v]));
    const full = assessSpcCharts(useData.getState().model, useApp.getState().spcRules, DEFAULT_RULE_K, 'i-mr');
    expect(full.events.length).toBeGreaterThan(MAX_XLSX_VIOLATION_ROWS);
    let job: ExportJob | null = null;
    vi.spyOn(platform, 'exportFile').mockImplementation(async (value) => { job = value; return 'drift.xlsx'; });
    render(<App />);
    useApp.setState({ modal: 'export', exportFmt: 'excel' });
    fireEvent.click(await screen.findByRole('button', { name: '导出' }));
    await waitFor(() => expect(job).not.toBeNull(), { timeout: 30_000 });
    const wb = XLSX.read(job!.bytes!, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['失控点'], { header: 1, raw: false });
    expect(rows.length).toBe(MAX_XLSX_VIOLATION_ROWS + 2);
    expect(rows[rows.length - 1].join('')).toContain(`共 ${full.events.length} 条判异事件`);
  }, 120_000);
});
