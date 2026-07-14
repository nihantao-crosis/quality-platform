/**
 * 当前分析的通用报表载荷。
 *
 * 页面/统计模块只负责把已经验证过的结果整理成表格和 SVG；导出层负责把同一份载荷
 * 写入 HTML、Excel、Word 与 PowerPoint，避免四种格式各自重新计算而产生口径漂移。
 */
export interface AnalysisReportTable {
  title: string;
  headers: string[];
  rows: Array<Array<string | number>>;
  note?: string;
}

export interface AnalysisReportChart {
  title: string;
  svg: string;
  width: number;
  height: number;
  note?: string;
}

export interface AnalysisReportPayload {
  /** 稳定标识，用于 Excel sheet 名和测试。 */
  kind: string;
  title: string;
  subtitle: string;
  generatedAt: string;
  summary: string[];
  warnings: string[];
  tables: AnalysisReportTable[];
  charts: AnalysisReportChart[];
  /** 是否直接消费活动连续型工作表；未指定时按 kind 做兼容推断。 */
  usesWorksheet?: boolean;
}

/** Excel sheet 名上限为 31 字符，且不能包含这些保留字符。 */
export function safeSheetName(raw: string, fallback = '当前分析'): string {
  const cleaned = raw.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (cleaned || fallback).slice(0, 31);
}

/** 该专项分析是否直接消费连续型活动工作表。P/C、AQL、帕累托使用独立数据源。 */
export function analysisUsesWorksheet(analysis: AnalysisReportPayload): boolean {
  if (analysis.usesWorksheet !== undefined) return analysis.usesWorksheet;
  return analysis.kind === 'anova'
    || analysis.kind === 'doe'
    || analysis.kind === 'capability'
    || analysis.kind === 't1'
    || analysis.kind === 'reg'
    || (analysis.kind === 'spc' && !/^[PC] 控制图/.test(analysis.title));
}
