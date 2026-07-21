/** 当前分析专项导出：四种格式必须消费同一份载荷。 */
import { DEFAULT_SPC_RULES } from '../../store/appStore';
import { describe, expect, it } from 'vitest';
import { assessSpcCharts } from '../../core';
import * as XLSX from 'xlsx';
import { buildData, computeVarModel } from '../../core';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { buildXlsx } from '../../platform/xlsxExport';
import type { AnalysisReportPayload } from '../../platform/analysisReportModel';

const D = buildData();
const M = computeVarModel(
  '专项数据.mtw',
  ['直径1', '直径2', '直径3', '直径4', '直径5'],
  D.subs.map((s) => s.vals),
);
const SPEC = { lsl: 24.9, tgt: 25, usl: 25.1 };
const REPORT: AnalysisReportPayload = {
  kind: 'aql',
  title: 'AQL 接收抽样专项报告',
  subtitle: 'N=2000 · 水平 II · AQL 1.0',
  generatedAt: '2026-07-14 18:00:00',
  summary: ['当前方案 K / n=125 / Ac=3 / Re=4', '本批不合格数 2，判定接收'],
  warnings: ['生产放行应同时保留批号和检验员。'],
  tables: [{
    title: '抽样方案',
    headers: ['状态', '字码', 'n', 'Ac', 'Re'],
    rows: [['正常', 'K', 125, 3, 4]],
    note: '依据当前配置生成。',
  }],
  charts: [],
};

const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b;

describe('当前分析专项导出', () => {
  it('HTML 使用专项标题、结论、警告和表格，不再回落通用能力报告', () => {
    const html = buildHtmlReport(M, SPEC, assessSpcCharts(M, DEFAULT_SPC_RULES), REPORT);
    expect(html).toContain('AQL 接收抽样专项报告');
    expect(html).toContain('本批不合格数 2');
    expect(html).toContain('生产放行应同时保留批号');
    expect(html).toContain('抽样方案');
    expect(html).not.toContain('过程能力直方图');
    expect(html).not.toContain('工作表 专项数据.mtw');
  });

  it('Excel 增加当前分析 sheet，并写入相同结论', () => {
    const bytes = buildXlsx(M, SPEC, assessSpcCharts(M, DEFAULT_SPC_RULES), REPORT);
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheetName = wb.SheetNames.find((name) => name.includes('aql-当前分析'));
    expect(sheetName).toBeTruthy();
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[sheetName!], { header: 1 });
    expect(rows.flat().join('|')).toContain('本批不合格数 2');
    expect(wb.SheetNames).toEqual(['aql-当前分析']);
    expect(wb.SheetNames).not.toContain('统计摘要');
    expect(wb.SheetNames).not.toContain('失控点');
  });

  it('P/C 属性图专项 Excel 不混入无关连续型工作表与能力结论', () => {
    const report: AnalysisReportPayload = {
      ...REPORT,
      kind: 'spc',
      title: 'P 控制图专项报告',
      subtitle: '属性数据',
    };
    const wb = XLSX.read(buildXlsx(M, SPEC, assessSpcCharts(M, DEFAULT_SPC_RULES), report), { type: 'array' });
    expect(wb.SheetNames).toEqual(['spc-当前分析']);
    expect(wb.SheetNames).not.toContain('数据');
    expect(wb.SheetNames).not.toContain('统计摘要');
    expect(wb.SheetNames).not.toContain('失控点');
  });

  it('ANOVA/DOE 专项只导出带角色的分析原始数据，不派生伪子组均值/极差', () => {
    const report: AnalysisReportPayload = {
      ...REPORT,
      kind: 'anova',
      title: '单因子 ANOVA 专项报告',
      tables: [{
        title: '用于 ANOVA 的原始观测',
        headers: ['工作表行', '设备', '压入力'],
        rows: [[1, 'A', 10], [2, 'A', 11], [3, 'B', 20], [4, 'B', 21]],
      }],
    };
    const wb = XLSX.read(buildXlsx(M, SPEC, assessSpcCharts(M, DEFAULT_SPC_RULES), report), { type: 'array' });
    expect(wb.SheetNames).toEqual(['anova-当前分析']);
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['anova-当前分析'], { header: 1 });
    expect(rows.flat().join('|')).toContain('工作表行|设备|压入力');
    expect(rows.flat()).not.toContain('均值');
    expect(rows.flat()).not.toContain('极差');
    expect(wb.SheetNames).not.toContain('数据');
    expect(wb.SheetNames).not.toContain('统计摘要');
  });

  it('Word 与 PowerPoint 专项路径均生成合法 OOXML', async () => {
    const [docx, pptx] = await Promise.all([
      buildDocx(M, SPEC, {}, assessSpcCharts(M, DEFAULT_SPC_RULES), REPORT),
      buildPptx(M, SPEC, {}, assessSpcCharts(M, DEFAULT_SPC_RULES), REPORT),
    ]);
    expect(isZip(docx)).toBe(true);
    expect(isZip(pptx)).toBe(true);
    expect(docx.length).toBeGreaterThan(2000);
    expect(pptx.length).toBeGreaterThan(10000);
  });
});
