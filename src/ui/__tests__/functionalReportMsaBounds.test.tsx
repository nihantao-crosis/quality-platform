/** @vitest-environment jsdom */
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessGage,
  computeGageRR,
  computeVarModel,
  DEFAULT_RULE_K,
  evalRules,
  expandSpcRuleItems,
  type GageObservation,
  type NelsonRules,
} from '../../core';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { buildHtmlReport } from '../../platform/htmlReport';
import type { AnalysisReportPayload } from '../../platform/analysisReportModel';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { MAX_SPC_REPORT_DETAIL_ROWS, MAX_XLSX_SHEET_ROWS } from '../../platform/reportLabels';
import { buildAnalysisXlsxRows, buildXlsx } from '../../platform/xlsxExport';
import { useApp } from '../../store/appStore';
import { useAnalyses } from '../../store/analyses';
import { useData } from '../../store/dataStore';
import { GageRR } from '../pages/SimplePages';
import { gageBarCategories } from '../charts/gagePanels';
import { chartTokens } from '../tokens';

const ALL_RULES: NelsonRules = {
  r1: true, r2: true, r3: true, r4: true,
  r5: true, r6: true, r7: true, r8: true,
};

const SPEC = { lsl: null, tgt: 0, usl: null };

afterEach(() => {
  cleanup();
  useAnalyses.setState({ saved: [], lastError: null });
  localStorage.removeItem('qp-analyses-v1');
  localStorage.removeItem('qp-analysis-data-v1');
  useData.getState().resetDemo();
});

function spcDetailTable(report: AnalysisReportPayload) {
  const table = report.tables.find((candidate) => candidate.title === '判异明细');
  if (!table) throw new Error('测试报告缺少判异明细');
  return table;
}

describe('SPC 专项 payload 在格式化前有界', () => {
  it('小夹具的有界总数/按准则计数与历史全量展开逐条一致', () => {
    const data = [-2, 2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 2];
    const full = evalRules(data, 0, 3, ALL_RULES, DEFAULT_RULE_K);
    const expanded = expandSpcRuleItems(full.viol, full.list, 'I', DEFAULT_RULE_K);
    const bounded = evalRules(data, 0, 3, ALL_RULES, DEFAULT_RULE_K, { pointRuleDetailLimit: 3 });
    const expectedByRule: Record<number, number> = {};
    for (const item of expanded) expectedByRule[item.rule] = (expectedByRule[item.rule] ?? 0) + 1;

    expect(bounded.list).toEqual([]); // 有界模式不再构建滑窗触发 list
    expect(bounded.pointRuleSummary).toMatchObject({
      total: expanded.length,
      affectedCount: full.viol.size,
      byRule: expectedByRule,
      truncated: expanded.length > 3,
    });
    expect(bounded.pointRuleSummary?.items).toEqual(
      expanded.slice(0, 3).map(({ chartLabel: _chartLabel, ...item }) => item),
    );
  });

  it.each(['classic', 'pooled'] as const)(
    '20 万子组的 %s 分阶段 X̄/R 保留真实总数，仅物化前 2 万条',
    (sigmaMethod) => {
      const pointCount = 200_000;
      // 均值与极差都上下交替：X̄ 与 R 两张图都会中准则 4，
      // X̄ 还会中准则 8，从而产生远多于上限的去重点×准则明细。
      const rows = Array.from({ length: pointCount }, (_, index) => (
        index % 2 === 0 ? [-1.05, -0.95] : [0.5, 1.5]
      ));
      const stages = Array.from({ length: pointCount }, (_, index) => index < pointCount / 2 ? '改进前' : '改进后');
      useData.setState({
        model: computeVarModel(`stage-${sigmaMethod}.csv`, ['M1', 'M2'], rows),
        textCols: [{ name: '阶段', values: stages }],
        pendingCells: [],
      });
      useApp.setState({
        page: 'spc', spcType: 'xbar-r', spcDataLayout: 'rows',
        spcValueCol: null, spcSubgroupCol: null, spcStageCol: '阶段',
        spcSigmaMethod: sigmaMethod, spcRules: ALL_RULES, spcRuleK: DEFAULT_RULE_K,
        spcShowZones: false,
      });

      const report = buildActiveAnalysisReport();
      expect(report?.kind).toBe('spc');
      const detail = spcDetailTable(report!);
      expect(detail.rows).toHaveLength(MAX_SPC_REPORT_DETAIL_ROWS);
      // X̄ 图每点命中 4/5/8，R 图每点命中 4：真实总数固定为 4×点数。
      expect(detail.totalRows).toBe(pointCount * 4);
      expect(detail.note).toContain(`共 ${detail.totalRows} 条`);
      expect(detail.note).toContain(`前 ${MAX_SPC_REPORT_DETAIL_ROWS} 条`);
      // 结论不得把截断后的 2 万行当成实际受影响点数。
      expect(report!.summary.join(' ')).toContain(`${pointCount} 个异常点`);
      const limits = report!.tables.find((table) => table.title === '控制限');
      expect(limits?.rows.filter((row) => String(row[0]).startsWith('R ·')).map((row) => row[4]))
        .toEqual([pointCount / 2, pointCount / 2]);
    },
    120_000,
  );

  it('20 万点 I-MR 全准则模式的汇总不随明细前缀截断', () => {
    const pointCount = 200_000;
    const rows = Array.from({ length: pointCount }, (_, index) => [index % 2 === 0 ? -1 : 1]);
    useData.setState({
      model: computeVarModel('imr-200k.csv', ['测量'], rows),
      textCols: [], pendingCells: [],
    });
    useApp.setState({
      page: 'spc', spcType: 'i-mr', spcDataLayout: 'auto',
      spcValueCol: '测量', spcSubgroupCol: null, spcStageCol: null,
      spcSigmaMethod: 'classic', spcRules: ALL_RULES, spcRuleK: DEFAULT_RULE_K,
      spcShowZones: false,
    });

    const report = buildActiveAnalysisReport();
    const detail = spcDetailTable(report!);
    expect(detail.rows).toHaveLength(MAX_SPC_REPORT_DETAIL_ROWS);
    // I 图交替序列中准则 4 和 7，MR 为常量不命中，因此每个 I 点恰好 2 条。
    expect(detail.totalRows).toBe(pointCount * 2);
    expect(detail.note).toContain(`共 ${detail.totalRows} 条`);
    expect(report!.summary.join(' ')).toContain(`检测到 ${pointCount} 个失控点`);
    expect(report!.summary.join(' ')).not.toContain(`检测到 ${MAX_SPC_REPORT_DETAIL_ROWS} 个失控点`);

    // “保存到项目”也只需真实去重点数，不得再展开百万条点-准则文字明细。
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved?.metric).toContain(`${pointCount} 个失控点`);
  }, 120_000);

  it('能力专项报告的 20 万行源数据在 payload 构建前有界，但保留真实总行数', () => {
    const pointCount = 200_000;
    const rows = Array.from({ length: pointCount }, (_, index) => [index % 2 === 0 ? -1 : 1]);
    useData.setState({
      model: computeVarModel('capability-200k.csv', ['测量'], rows),
      textCols: [], pendingCells: [],
    });
    useApp.setState({
      page: 'capability', activeVar: '测量',
      lsl: -10, tgt: 0, usl: 10, lslOn: true, uslOn: true,
      capabilityWarningAcknowledgement: null,
      spcType: 'i-mr', spcSigmaMethod: 'classic',
      spcRules: ALL_RULES, spcRuleK: DEFAULT_RULE_K,
    });

    const report = buildActiveAnalysisReport();
    const source = report?.tables.find((table) => table.title.includes('用于能力分析'));
    expect(report?.kind).toBe('capability');
    expect(source?.rows).toHaveLength(MAX_SPC_REPORT_DETAIL_ROWS);
    expect(source?.totalRows).toBe(pointCount);
    expect(source?.note).toContain(`原始数据共 ${pointCount.toLocaleString()} 行`);
  }, 120_000);

  it('四格式据 totalRows 如实说明上游截断，PPT 最多先构建 20 页数据', async () => {
    const logicalTotal = 400_000;
    const materialized = Array.from({ length: MAX_SPC_REPORT_DETAIL_ROWS }, (_, index) => [index + 1, 4, '上下交替']);
    const analysis: AnalysisReportPayload = {
      kind: 'spc', title: '有界 SPC 报告', subtitle: '消费端契约', generatedAt: '2026-08-13 10:00:00',
      summary: ['共 200000 个受影响点。'], warnings: [], charts: [],
      tables: [{
        title: '判异明细', headers: ['点', '准则', '说明'], rows: materialized, totalRows: logicalTotal,
      }],
    };
    // 用小预算走生产同一装配器，验证「数据+截断说明」绝不越过工作表行预算，
    // 避免测试为此物化 1048576 行。
    const budgetRows = buildAnalysisXlsxRows(analysis, 12);
    expect(budgetRows).toHaveLength(12);
    expect(budgetRows[budgetRows.length - 1]?.join('')).toContain('Excel 单工作表最多 12 行');
    const model = computeVarModel('小工作表.csv', ['x'], [[1], [2]]);
    const html = buildHtmlReport(model, SPEC, null, analysis);
    const xlsx = XLSX.read(buildXlsx(model, SPEC, null, analysis), { type: 'array' });
    const [docxBytes, pptxBytes] = await Promise.all([
      buildDocx(model, SPEC, {}, null, analysis),
      buildPptx(model, SPEC, {}, null, analysis),
    ]);
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
    const wordXml = await docx.file('word/document.xml')!.async('string');
    const slideNames = Object.keys(pptx.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const slideXml = (await Promise.all(slideNames.map((name) => pptx.file(name)!.async('string')))).join('\n');
    const sheet = xlsx.Sheets[xlsx.SheetNames[0]];
    const sheetRows = XLSX.utils.sheet_to_json<Array<string | number>>(sheet, { header: 1 });
    const xlsxText = sheetRows.flat().join('|');

    expect(html).toContain(`表格共 ${logicalTotal} 行，图文报告仅列前 2000 行`);
    expect(wordXml).toContain(`表格共 ${logicalTotal} 行`);
    expect(wordXml).toContain('Word 摘要仅列前 2000 行');
    expect(slideXml).toContain(`表格共 ${logicalTotal} 行`);
    expect(slideXml).toContain('PPT（20 页）仅列前 280 行');
    expect(xlsxText).toContain(`表格共 ${logicalTotal} 行，Excel仅列前 ${MAX_SPC_REPORT_DETAIL_ROWS} 行`);
    for (const content of [html, wordXml, slideXml, xlsxText]) {
      expect(content).toContain('未导出的明细请缩小数据范围或减少启用的判异准则');
      expect(content).not.toContain('完整明细请导出 Excel');
    }
    expect(slideNames.length).toBeLessThanOrEqual(23); // 封面+结论+20 页表+截断说明
    expect(sheetRows.length).toBeLessThanOrEqual(MAX_XLSX_SHEET_ROWS);
  }, 60_000);
});

function smallGageFixture(): { observations: GageObservation[]; rows: number[][]; parts: string[]; operators: string[] } {
  const values = [10, 11, 10.5, 11.5, 20, 21, 20.5, 21.5];
  const parts = ['P1', 'P1', 'P1', 'P1', 'P2', 'P2', 'P2', 'P2'];
  const operators = ['A', 'A', 'B', 'B', 'A', 'A', 'B', 'B'];
  const observations: GageObservation[] = [];
  for (let part = 0; part < 2; part++) {
    for (let operator = 0; operator < 2; operator++) {
      for (let trial = 0; trial < 2; trial++) {
        const index = part * 4 + operator * 2 + trial;
        observations.push({ part, operator, trial, value: values[index] });
      }
    }
  }
  return { observations, rows: values.map((value) => [value]), parts, operators };
}

describe('MSA 有限极小公差 fail-closed', () => {
  it('Number.MIN_VALUE 不产生 Infinity/NaN，页面与四格式统一标为未计算', async () => {
    const fixture = smallGageFixture();
    const tolerance = { mode: 'width' as const, value: Number.MIN_VALUE };
    const result = computeGageRR(fixture.observations, tolerance);
    const assessment = assessGage(result, 'factory');
    expect(result.toleranceNote).toMatch(/下溢为 0|超出有限数值范围/);
    expect(result.components.every((component) => component.pctTolerance === null)).toBe(true);
    expect(assessment).toMatchObject({ label: '不能判定', blocked: true });
    expect(result.components.flatMap((component) => [
      component.variance, component.sd, component.studyVar,
      component.pctContribution, component.pctStudyVar,
    ]).every(Number.isFinite)).toBe(true);
    expect(gageBarCategories(result).flatMap((category) => [
      category.contrib, category.study, ...(category.tol == null ? [] : [category.tol]),
    ]).every(Number.isFinite)).toBe(true);

    const model = computeVarModel('msa-min.csv', ['Y'], fixture.rows);
    useData.setState({
      model,
      textCols: [
        { name: 'Part', values: fixture.parts },
        { name: 'Operator', values: fixture.operators },
      ],
      pendingCells: [],
    });
    useApp.setState({
      page: 'gagerr', gageUseReal: true,
      gageValueName: 'Y', gagePartName: 'Part', gageOperatorName: 'Operator',
      gageTolMode: 'width', gageTolValue: Number.MIN_VALUE, gageStandard: 'factory',
      gageBatchCols: null, gageTolByCol: {},
      gageGaugeName: '', gageReportBy: '', gageStudyDate: '', gageNotes: '',
    });

    const page = render(createElement(GageRR, { T: chartTokens('经典', true) }));
    expect(page.container.textContent).toContain('不能判定');
    expect(page.container.textContent).toMatch(/下溢为 0|超出有限数值范围/);
    expect(page.container.textContent).not.toMatch(/\b(?:NaN|[+-]?Infinity)\b/);
    cleanup();

    const report = buildActiveAnalysisReport();
    expect(report?.warnings.join(' ')).toMatch(/下溢为 0|超出有限数值范围/);
    const componentRow = report?.tables.find((table) => table.title === '方差分量与研究变异')?.rows[0];
    expect(componentRow?.[componentRow.length - 1]).toBe('—');
    const chartMarkup = report!.charts[0].svg;
    expect(chartMarkup).not.toMatch(/(?:x|y|x1|y1|x2|y2|cx|cy|points|d)="[^"]*(?:NaN|[+-]?Infinity)/);

    const html = buildHtmlReport(model, SPEC, null, report!);
    const xlsx = XLSX.read(buildXlsx(model, SPEC, null, report!), { type: 'array' });
    const [docxBytes, pptxBytes] = await Promise.all([
      buildDocx(model, SPEC, {}, null, report!),
      buildPptx(model, SPEC, {}, null, report!),
    ]);
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
    const wordXml = await docx.file('word/document.xml')!.async('string');
    const slideXml = (await Promise.all(Object.keys(pptx.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map((name) => pptx.file(name)!.async('string')))).join('\n');
    const xlsxText = xlsx.SheetNames.map((name) => (
      XLSX.utils.sheet_to_json<Array<string | number>>(xlsx.Sheets[name], { header: 1 }).flat().join('|')
    )).join('|');

    for (const content of [html, xlsxText, wordXml, slideXml]) {
      expect(content).toContain('不能判定');
      expect(content).not.toMatch(/\b(?:NaN|[+-]?Infinity)\b/);
    }
  }, 60_000);
});
