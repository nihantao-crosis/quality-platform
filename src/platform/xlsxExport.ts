/**
 * 真 Excel (.xlsx) 导出 — SheetJS 生成多 sheet 工作簿：数据 / 统计摘要 / 失控点。
 * 两端共用（桌面经 Rust 落盘,Web 走 blob 下载）。
 */
import * as XLSX from 'xlsx';
import {
  nf, computeCapability, capabilityInputError, evaluateAndersonDarling, type VarModel, type SpcAssessment,
  assessCapability,
} from '../core';
import type { ReportSpec } from './report';
import { analysisTableTotalRows, safeSheetName, type AnalysisReportPayload } from './analysisReportModel';
import {
  timestampText, appVersionText, reportSpecText, withinSigmaLabel,
  MAX_XLSX_SHEET_ROWS, MAX_XLSX_VIOLATION_ROWS, tableTruncationNote, violationTruncationNote,
  capabilityCaliberLine, type ReportCapabilityOptions,
} from './reportLabels';

type XlsxCell = string | number | XLSX.CellObject;

/** 定点小数串(nf/toFixed 的产物):不接受前导零整数(如编号「007」)与正号,以免把标识符改写成数。 */
const FIXED_NUMBER_TEXT = /^-?(?:0|[1-9]\d*)(?:\.(\d+))?$/;
/** 有效数字串(reportNum/toPrecision 的指数分支,如「4.703e-9」)。 */
const EXP_NUMBER_TEXT = /^-?\d(?:\.(\d+))?e[+-]\d+$/;

/**
 * 专项载荷单元格 → Excel 单元格(PLATFORM-15)。专项载荷里的统计量与原始观测是
 * 按报告显示口径格式化好的数字串,直接交给 aoa_to_sheet 会写成 t:'s'「以文本形式存储的数字」:
 * SUM/AVERAGE 失效、排序按字典序、粘贴到 Minitab 成文本列。此处把**整格就是一个数**的
 * 字符串写成数值单元格(t:'n'),并用单元格数字格式保留原显示位数(如 25.0000、4.703E-09)。
 * 超过 15 位的纯整数串(长编号/条码)无法无损转成 double,保持文本;带小数部分的串是
 * 报告按显示位数格式化的统计量/观测(如 fmt(v,10) 的「123456.0000000000」),一律写数值。
 */
export function xlsxTableCell(value: string | number): XlsxCell {
  if (typeof value !== 'string') return value;
  const fixed = FIXED_NUMBER_TEXT.exec(value);
  const exp = fixed ? null : EXP_NUMBER_TEXT.exec(value);
  if (!fixed && !exp) return value;
  if (fixed && fixed[1] === undefined && value.replace(/^-/, '').length > 15) return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  const v = numeric === 0 ? 0 : numeric; // 「-0.0000」不写负零
  const decimals = (fixed ?? exp)![1]?.length ?? 0;
  if (exp) return { t: 'n', v, z: `0${decimals > 0 ? `.${'0'.repeat(decimals)}` : ''}E+00` };
  return decimals > 0 ? { t: 'n', v, z: `0.${'0'.repeat(decimals)}` } : { t: 'n', v };
}

/**
 * 专项报告单表装配：生产始终使用 Excel 硬上限；可注入更小预算仅用于
 * 无需构造百万行的边界测试。最后一行预留给容量截断说明。
 */
export function buildAnalysisXlsxRows(
  analysis: AnalysisReportPayload,
  requestedRowLimit = MAX_XLSX_SHEET_ROWS,
): XlsxCell[][] {
  const rowLimit = Number.isSafeInteger(requestedRowLimit) && requestedRowLimit > 0
    ? Math.min(requestedRowLimit, MAX_XLSX_SHEET_ROWS)
    : 1;
  const rows: XlsxCell[][] = [];
  let capacityTruncated = false;
  const append = (row: XlsxCell[], reserveNotice = true): boolean => {
    const limit = rowLimit - (reserveNotice ? 1 : 0);
    if (rows.length >= limit) {
      capacityTruncated = true;
      return false;
    }
    rows.push(row);
    return true;
  };
  append([analysis.title]);
  append([analysis.subtitle]);
  append(['生成时间', analysis.generatedAt]);
  append(['软件版本', appVersionText()]);
  append([]);
  append(['结论']);
  for (const line of analysis.summary) append([line]);
  if (analysis.warnings.length > 0) {
    append([]);
    append(['注意事项']);
    for (const line of analysis.warnings) append([line]);
  }
  for (const table of analysis.tables) {
    if (!append([]) || !append([table.title]) || !append(table.headers)) break;
    const totalRows = analysisTableTotalRows(table);
    let shownRows = 0;
    // 循环追加而非 push(...spread):13 万行以上的专项表会超出实参上限直接 RangeError。
    for (const row of table.rows) {
      if (!append(row.map(xlsxTableCell))) break;
      shownRows++;
    }
    if (totalRows > shownRows) {
      append([tableTruncationNote(totalRows, shownRows, 'Excel', false)]);
    }
    if (table.note) append([table.note]);
    if (capacityTruncated) break;
  }
  if (analysis.charts.length > 0) {
    append([]);
    append(['图形清单']);
    for (const chart of analysis.charts) append([chart.title, chart.note ?? '见 HTML/Word/PPT 图文报告']);
  }
  if (capacityTruncated) {
    append([
      `已截断：Excel 单工作表最多 ${rowLimit.toLocaleString()} 行；`
      + '未导出的明细请缩小数据范围或减少启用的判异准则。',
    ], false);
  }
  return rows;
}

export function buildXlsx(
  M: VarModel,
  spec: ReportSpec,
  assessment: SpcAssessment | null,
  analysis?: AnalysisReportPayload,
  capabilityModel: VarModel = M,
  capabilitySpcViolations?: number | null,
  capabilityOptions: ReportCapabilityOptions = {},
): Uint8Array {
  const wb = XLSX.utils.book_new();

  const appendDataSheet = () => {
    const showDerived = M.hasSubgroups;
    const dispersionHeader = assessment?.family === 'xbar-s' ? '标准差' : '极差';
    const head = [M.hasSubgroups ? '子组' : '观测', ...M.colNames, ...(showDerived ? ['均值', dispersionHeader] : [])];
    const dataRows = M.subs.map((s) => [
      s.i,
      ...s.vals,
      // PLATFORM-14:写原始 double,不得 Number(nf(·,4)) 预先四舍五入(小量级数据会被写成数值 0)
      ...(showDerived ? [s.mean, assessment?.family === 'xbar-s' ? M.svals[s.i - 1] : s.range] : []),
    ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...dataRows]), '数据');
  };

  // 当前页面有专项分析时，Excel 只导出与该分析有关的数据与结果。
  // 尤其 AQL / Pareto / P / C 图不得夹带当前连续型工作表的能力摘要。
  if (analysis) {
    const rows = buildAnalysisXlsxRows(analysis);
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
  const capError = capabilityInputError(C.all, C.sigmaWithin, spec, capabilityOptions);
  const cap = capError ? null : computeCapability(C.all, C.sigmaWithin, spec, capabilityOptions);
  const xlsxAd = evaluateAndersonDarling(C.all).result;
  const capAssessment = cap ? assessCapability({
    cpk: cap.cpk, verdict: cap.verdict, adP: xlsxAd ? xlsxAd.p : null, n: C.all.length,
    spcViolations: capSpcCount,
  }) : null;
  // PLATFORM-14:能力指数写原始 double,显示位数交给单元格数字格式(0.000),不预先四舍五入。
  // 非有限值(σ=0 时的 Z.bench 等)仍交 aoa_to_sheet 的原生分支写成错误单元格,与旧行为一致。
  const index3 = (value: number | null): XlsxCell => (
    value == null ? '—' : Number.isFinite(value) ? { t: 'n', v: value, z: '0.000' } : value
  );
  const capRows: XlsxCell[][] = cap && capAssessment ? [
    ['Cp', index3(cap.cp)],
    ['Cpk', index3(cap.cpk)],
    ['Pp', index3(cap.pp)],
    ['Ppk', index3(cap.ppk)],
    ['Cpm', index3(cap.cpm)],
    ['CPU', index3(cap.cpu)],
    ['CPL', index3(cap.cpl)],
    ['Z.bench', index3(cap.zBench)],
    ['西格玛水平', index3(cap.sigmaLevel)],
    ['PPM 合计（整体）', Math.round(cap.ppm.overall.total)],
    ['判定', capAssessment.status],
  ] : [
    ['过程能力', `未运行: ${capError}`],
  ];
  // 稳定性是独立于能力计算的 SPC 结果；即使 σ=0/规格闸门使能力未运行，也必须保留这一行。
  const stabilityRow: XlsxCell[] = [
    '过程稳定性',
    assessment.chartPointCount > 0
      ? `各图累计 ${assessment.chartPointCount} 个失控点（${assessment.locationLabel} 图 ${assessment.locationPoints} 个 + ${assessment.dispersionLabel} 图 ${assessment.dispersionPoints} 个）；去重${assessment.analysisUnitLabel} ${assessment.uniqueAnalysisUnitCount} 个${cap ? '——能力值仅描述当前样本' : '——过程不稳定'}`
      : '控制图无失控信号',
  ];
  const xlsxCaliberLine = capabilityCaliberLine(capabilityOptions, capSpcCount);
  const adEval = evaluateAndersonDarling(C.all);
  const adRow = adEval.result
    ? `A²*=${nf(adEval.result.a2star, 3)}, P ${adEval.result.p < 0.005 ? '< 0.005' : '= ' + nf(adEval.result.p, 3)} → ${adEval.result.normal ? '未拒绝正态假设' : '显著偏离正态'}`
    : (adEval.unavailableReason ?? '不可判定');
  const summary: XlsxCell[][] = [
    ['质量分析平台 · 统计摘要', ''],
    // 与其余三格式同口径的元数据(双审 P3:此前 Excel 缺生成时间/正态性/CPU/CPL,四格式均缺版本号)
    ['软件版本', appVersionText()],
    ['生成时间', timestampText()],
    ['工作表', M.name],
    ['数据结构', M.hasSubgroups ? '子组数据' : '单值观测（I-MR）'],
    ...(M.hasSubgroups ? [['子组数 k', M.k], ['子组大小 n', M.n]] : []),
    ...(C !== M ? [
      ['能力数据结构', C.hasSubgroups ? '子组数据' : '单值观测（I-MR）'],
      ...(C.hasSubgroups ? [['能力子组数 k', C.k], ['能力子组大小 n', C.n]] : []),
      ['SPC 观测数 N', M.all.length],
    ] : []),
    [C !== M ? '能力观测数 N' : '观测数 N', C.all.length],
    // PLATFORM-14:原始 double(小量级数据不再被 Number(nf(·,5)) 写成数值 0)
    ['能力口径均值', C.oMean],
    [withinSigmaLabel(C), C.sigmaWithin],
    ['σ 整体', C.oSd],
    ['', ''],
    ['规格 LSL / 目标 / USL', reportSpecText(spec)],
    ['正态性 (Anderson-Darling)', adRow],
    ...(capabilityOptions.allowDistantSpec ? [['规格风险确认', '用户已核对当前测量角色与规格，并显式确认继续计算远距离规格']] : []),
    ...capRows,
    stabilityRow,
    ...(xlsxCaliberLine ? [['能力稳定性口径', xlsxCaliberLine]] : []),
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
