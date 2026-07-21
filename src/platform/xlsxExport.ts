/**
 * 真 Excel (.xlsx) 导出 — SheetJS 生成多 sheet 工作簿：数据 / 统计摘要 / 失控点。
 * 两端共用（桌面经 Rust 落盘,Web 走 blob 下载）。
 */
import * as XLSX from 'xlsx';
import {
  nf, computeCapability, capabilityInputError, type VarModel, type SpcAssessment,
  assessCapability, evaluateAndersonDarling,
} from '../core';
import type { ReportSpec } from './report';
import { safeSheetName, type AnalysisReportPayload } from './analysisReportModel';
import { reportSpecText, withinSigmaLabel, MAX_XLSX_VIOLATION_ROWS, violationTruncationNote } from './reportLabels';

export function buildXlsx(
  M: VarModel,
  spec: ReportSpec,
  assessment: SpcAssessment | null,
  analysis?: AnalysisReportPayload,
  capabilityModel: VarModel = M,
  capabilitySpcViolations?: number | null,
): Uint8Array {
  const wb = XLSX.utils.book_new();

  const appendDataSheet = () => {
    const showDerived = M.hasSubgroups;
    const head = [M.hasSubgroups ? '子组' : '观测', ...M.colNames, ...(showDerived ? ['均值', '极差'] : [])];
    const dataRows = M.subs.map((s) => [
      s.i,
      ...s.vals,
      ...(showDerived ? [Number(nf(s.mean, 4)), Number(nf(s.range, 4))] : []),
    ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...dataRows]), '数据');
  };

  // 当前页面有专项分析时，Excel 只导出与该分析有关的数据与结果。
  // 尤其 AQL / Pareto / P / C 图不得夹带当前连续型工作表的能力摘要。
  if (analysis) {
    const rows: Array<Array<string | number>> = [
      [analysis.title],
      [analysis.subtitle],
      ['生成时间', analysis.generatedAt],
      [],
      ['结论'],
      ...analysis.summary.map((line) => [line]),
    ];
    if (analysis.warnings.length > 0) {
      rows.push([], ['注意事项'], ...analysis.warnings.map((line) => [line]));
    }
    for (const table of analysis.tables) {
      rows.push([], [table.title], table.headers, ...table.rows);
      if (table.note) rows.push([table.note]);
    }
    if (analysis.charts.length > 0) {
      rows.push([], ['图形清单'], ...analysis.charts.map((chart) => [chart.title, chart.note ?? '见 HTML/Word/PPT 图文报告']));
    }
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(rows),
      safeSheetName(`${analysis.kind}-当前分析`),
    );
    return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
  }
  if (!assessment) throw new Error('通用 Excel 报告缺少 SPC 判异结果');

  const C = capabilityModel;
  const capSpcCount = capabilitySpcViolations ?? assessment.chartPointCount;

  appendDataSheet();

  // Sheet 2: 统计摘要(能力输入闸门:规格不匹配等情况写「未运行」,数据 sheet 与其余章节照常导出)
  const capError = capabilityInputError(C.all, C.sigmaWithin, spec);
  const cap = capError ? null : computeCapability(C.all, C.sigmaWithin, spec);
  const xlsxAd = evaluateAndersonDarling(C.all).result;
  const capAssessment = cap ? assessCapability({
    cpk: cap.cpk, verdict: cap.verdict, adP: xlsxAd ? xlsxAd.p : null, n: C.all.length,
    spcViolations: capSpcCount,
  }) : null;
  const capRows: (string | number)[][] = cap && capAssessment ? [
    ['Cp', cap.cp == null ? '—' : Number(nf(cap.cp, 3))],
    ['Cpk', Number(nf(cap.cpk, 3))],
    ['Pp', cap.pp == null ? '—' : Number(nf(cap.pp, 3))],
    ['Ppk', Number(nf(cap.ppk, 3))],
    ['Cpm', cap.cpm == null ? '—' : Number(nf(cap.cpm, 3))],
    ['Z.bench', Number(nf(cap.zBench, 3))],
    ['西格玛水平', Number(nf(cap.sigmaLevel, 3))],
    ['PPM 合计（整体）', Math.round(cap.ppm.overall.total)],
    ['判定', capAssessment.status],
  ] : [
    ['过程能力', `未运行: ${capError}`],
  ];
  // 稳定性是独立于能力计算的 SPC 结果；即使 σ=0/规格闸门使能力未运行，也必须保留这一行。
  const stabilityRow: (string | number)[] = [
    '过程稳定性',
    assessment.chartPointCount > 0
      ? `各图累计 ${assessment.chartPointCount} 个失控点（${assessment.locationLabel} 图 ${assessment.locationPoints} 个 + ${assessment.dispersionLabel} 图 ${assessment.dispersionPoints} 个）；去重${assessment.analysisUnitLabel} ${assessment.uniqueAnalysisUnitCount} 个${cap ? '——能力值仅描述当前样本' : '——过程不稳定'}`
      : '控制图无失控信号',
  ];
  const summary: (string | number)[][] = [
    ['质量分析平台 · 统计摘要', ''],
    ['工作表', M.name],
    ['数据结构', M.hasSubgroups ? '子组数据' : '单值观测（I-MR）'],
    ...(M.hasSubgroups ? [['子组数 k', M.k], ['子组大小 n', M.n]] : []),
    ...(C !== M ? [
      ['能力数据结构', C.hasSubgroups ? '子组数据' : '单值观测（I-MR）'],
      ...(C.hasSubgroups ? [['能力子组数 k', C.k], ['能力子组大小 n', C.n]] : []),
      ['SPC 观测数 N', M.all.length],
    ] : []),
    [C !== M ? '能力观测数 N' : '观测数 N', C.all.length],
    ['能力口径均值', Number(nf(C.oMean, 5))],
    [withinSigmaLabel(C), Number(nf(C.sigmaWithin, 5))],
    ['σ 整体', Number(nf(C.oSd, 5))],
    ['', ''],
    ['规格 LSL / 目标 / USL', reportSpecText(spec)],
    ...capRows,
    stabilityRow,
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), '统计摘要');

  // Sheet 3: 失控点(v1.42.3:位置+离散图统一判异,与统计摘要「过程稳定性」同源,不再自相矛盾)
  const violRows: (string | number)[][] = [['点号', '图', 'Nelson 准则', '描述']];
  // 行数硬上限(v1.42.4):对抗性数据可产出 50 万+事件,完整写入会冻结/OOM;截断行写明总数
  const shownEvents = assessment.events.length > MAX_XLSX_VIOLATION_ROWS
    ? assessment.events.slice(0, MAX_XLSX_VIOLATION_ROWS)
    : assessment.events;
  shownEvents.forEach((v) => violRows.push([v.i + 1, v.chart, v.rule, v.desc]));
  if (assessment.events.length > shownEvents.length) {
    violRows.push(['…', '', '', violationTruncationNote(assessment.events.length, shownEvents.length)]);
  }
  if (assessment.events.length === 0) violRows.push(['—', '—', '—', assessment.verdictLine]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(violRows), '失控点');

  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}
