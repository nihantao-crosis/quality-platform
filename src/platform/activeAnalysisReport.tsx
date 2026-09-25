/**
 * 把“当前页面正在显示的分析”转换为统一专项报表载荷。
 *
 * 这里刻意复用页面相同的角色解析与 core 结构化报告，导出不得重新猜变量或回落演示。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MAX_SPC_REPORT_DETAIL_ROWS, timestampText, reportSpecDetailText, reportNum, reportRawFormatter } from './reportLabels';
import {
  analyzeFactorial,
  analyzeDoe,
  anovaGroups,
  buildAnovaInput,
  buildAnovaStructuredReport,
  buildAqlReportData,
  aqlTransitionActionLabel,
  aqlTransitionConditionText,
  isAqlTransitionRecord,
  buildDoeConclusion,
  buildDoeStructuredReport,
  capabilityInputError,
  capabilitySpecDistanceWarning,
  capabilityWarningFingerprint,
  computeCapability,
  computeDescriptive,
  computeVarModel,
  computeGageRR, assessGage, computeGagePanelData, CONTROL_CONSTANTS, withSigmaMethod, dataDecimals, GAGE_SINGLE_OPERATOR,
  countAnovaPendingCells,
  DEFECTS,
  DOE_DESIGN,
  detectFactorial, detectGeneralFactorial, analyzeGeneralFactorial, detectFractionalFactorial, analyzeFractionalFactorial, resolveDoeColumnsWide, MAX_FRACTIONAL_FACTORS,
  cusumSeries,
  evalLimitedRules,
  evalRules,
  ewmaSeries,
  factorialAdjustedMainMeans,
  factorialOptimizationDecision,
  factorialOptimizationTerms,
  factorialModelTerms,
  factorialHierarchyClosure,
  GAGE_TOLERANCE,
  gageStudyData,
  mainEffectMeans,
  isDoeAnalysisColumn,
  linearRegression,
  oneSampleT,
  prepareGageStudy, effectiveGageSelection,
  prepareSpcData,
  resolveAnovaMode,
  resolveDoeBlockValues,
  resolveNumericColumn,
  resolveSpcStage,
  stagedRange,
  stagedXbar,
  tInv,
  twoSampleT,
  wideScaleDisparate,
  andersonDarling,
  type AnovaGroup,
  type DoeRunMetadata,
  type PointRuleSummary,
  type RuleEvaluationResult,
  type RuleNo,
  type VarModel, type SpcChartFamily, type SpcStageResolution, spcChartFamilyFor, spcViewFamilyFor,
  assessCapability, countCapabilityViolations, capabilityStabilityCaliber, shewhartSigmaIssue, spcStabilityViewFromRoles,
} from '../core';
import { useApp, resolveGageTolerance, normalizeGageBatchCols } from '../store/appStore';
import { capabilitySpecKey, capabilitySubgroupSemantics, resolveCapabilityMeasurementData, useData } from '../store/dataStore';
import { paretoReport, spcReport, type SpcViolationSummary } from '../ui/reportData';
import { chartTokens } from '../ui/tokens';
import { ControlChart } from '../ui/charts/ControlChart';
import { NormalProbPlot, residualAxisScale } from '../ui/charts/NormalProbPlot';
import { BoxPlot, IndividualValuePlot, IntervalPlot, ParetoChart, MiniHist, groupedPlotWindow } from '../ui/charts/misc';
import { GageReportFigure, gageBarCategories } from '../ui/charts/gagePanels';
import { ScatterPlot } from '../ui/charts/ScatterPlot';
import { Histogram } from '../ui/charts/Histogram';
import { EffectsBar, MainEffects } from '../ui/charts/doe';
import { OcCurveChart } from '../ui/charts/OcCurveChart';
import { OcCurvePer100 } from '../ui/charts/OcCurvePer100';
import { FishboneChart } from '../ui/pages/Fishbone';
import { loadFishboneState } from '../store/fishboneStore';
import type { AnalysisReportChart, AnalysisReportPayload } from './analysisReportModel';
import { CUSUM_K, MINITAB_DEFAULT_CUSUM_H, MINITAB_DEFAULT_EWMA_L, cusumH, cusumParamsText, ewmaParamsText } from '../core/advancedSpcParams';

const T = chartTokens('经典', true);
const now = timestampText; // 合一:与四格式同一时间戳实现
// 第三轮 P2:图表标题/轴标签里的用户文本可携带 XML 非法控制字符,SVG 非良构会让
// Word/PPT 位图化整体失败并静默降级为占位文案——在唯一序列化出口统一剥离
// eslint-disable-next-line no-control-regex -- 目标正是剥离 XML 非法控制字符
const cleanSvgMarkup = (markup: string): string => markup.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '');
const svgChart = (title: string, element: React.ReactElement, width: number, height: number, note?: string): AnalysisReportChart => ({
  title,
  svg: cleanSvgMarkup(renderToStaticMarkup(element)),
  width,
  height,
  note,
});
const fmt = (value: number | null | undefined, digits = 4, scale?: number) => {
  if (value == null || Number.isNaN(value)) return '—';
  if (value === Infinity) return '+∞';
  if (value === -Infinity) return '−∞';
  // PLATFORM-14:定点只剩不到 3 位有效数字时改按有效数字,不再把均值/σ/控制限印成 0.0000;
  // scale 给出数据尺度时,|v| ≤ scale×1e-12 的浮点噪声按 0 输出(见 reportNum)
  return reportNum(value, digits, scale);
};
/**
 * 原始观测表的格式化器(fix2609k):整表一次决定形制——常规数据与既有报告逐字相同(定点 digits 位),
 * 定点会截断的小量级/高分辨率数据整表改全精度最短表示(见 reportRawFormatter)。
 */
const rawFmt = (values: Iterable<number>, digits = 8) => {
  const format = reportRawFormatter(values, digits);
  return (value: number) => (Number.isFinite(value) ? format(value) : fmt(value, digits));
};
function* groupValues(groups: ReadonlyArray<{ vals: readonly number[] }>): Generator<number> {
  for (const group of groups) yield* group.vals;
}
/** 数据尺度 max|x|(DOE 效应/系数/残差的浮点噪声判定基准)。 */
function magnitudeOf(values: Iterable<number>): number {
  let max = 0;
  for (const value of values) if (Number.isFinite(value) && Math.abs(value) > max) max = Math.abs(value);
  return max;
}

/**
 * 专项报告的判异路径不构建滑窗触发 list；引擎用 1 byte/点的 bit mask
 * 统计完整的点×准则命中，只将前 2 万条交给格式层。
 */
const SPC_REPORT_RULE_OPTIONS = {
  collectDetails: false,
  pointRuleDetailLimit: MAX_SPC_REPORT_DETAIL_ROWS,
} as const;

type ReportRuleEvaluation = Pick<RuleEvaluationResult, 'viol' | 'pointRuleSummary'>;

function requirePointRuleSummary(evaluation: ReportRuleEvaluation): PointRuleSummary {
  if (!evaluation.pointRuleSummary) throw new Error('SPC 专项报告缺少有界判异统计');
  return evaluation.pointRuleSummary;
}

function reportRuleItems(
  evaluation: ReportRuleEvaluation,
  chartLabel: string,
  indexOffset = 0,
) {
  return requirePointRuleSummary(evaluation).items.map((item) => ({
    ...item,
    i: item.i + indexOffset,
    chartLabel,
  }));
}

function combineRuleSummaries(
  evaluations: ReadonlyArray<{ evaluation: ReportRuleEvaluation; indexOffset?: number }>,
): SpcViolationSummary {
  const affected = new Set<number>();
  const byRule: Partial<Record<number, number>> = {};
  let pointRuleHitCount = 0;
  for (const { evaluation, indexOffset = 0 } of evaluations) {
    const summary = requirePointRuleSummary(evaluation);
    pointRuleHitCount += summary.total;
    evaluation.viol.forEach((index) => affected.add(index + indexOffset));
    for (const [rawRule, count] of Object.entries(summary.byRule)) {
      const rule = Number(rawRule) as RuleNo;
      byRule[rule] = (byRule[rule] ?? 0) + (count ?? 0);
    }
  }
  return { pointRuleHitCount, affectedPointCount: affected.size, byRule };
}

function spcDetailNote(summary: SpcViolationSummary, shown: number, suffix?: string): string {
  const bounded = summary.pointRuleHitCount > shown
    ? `共 ${summary.pointRuleHitCount} 条去重的点-准则命中，为保证导出安全仅保留前 ${shown} 条；未导出的明细请缩小数据范围或减少启用的判异准则。`
    : `共 ${summary.pointRuleHitCount} 条去重的点-准则命中。`;
  return suffix ? `${bounded}${suffix}` : bounded;
}

function boundedReportTableNote(base: string, totalRows: number, shownRows: number): string {
  if (totalRows <= shownRows) return base;
  return `${base}原始数据共 ${totalRows.toLocaleString()} 行，为保证导出的内存与格式安全，仅物化前 ${shownRows.toLocaleString()} 行。`;
}

function boundedGroupedValueRows(
  groups: ReadonlyArray<{ name: string; vals: readonly number[] }>,
): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [];
  const raw = rawFmt(groupValues(groups));
  for (const group of groups) {
    for (let index = 0; index < group.vals.length && rows.length < MAX_SPC_REPORT_DETAIL_ROWS; index++) {
      rows.push([group.name, index + 1, raw(group.vals[index])]);
    }
    if (rows.length >= MAX_SPC_REPORT_DETAIL_ROWS) break;
  }
  return rows;
}

function boundedAnovaObservationRows(
  groups: ReadonlyArray<{ name: string; vals: readonly number[]; rowIndices?: readonly number[] }>,
  preserveWorksheetOrder: boolean,
): Array<Array<string | number>> {
  const raw = rawFmt(groupValues(groups));
  if (!preserveWorksheetOrder) {
    const rows: Array<Array<string | number>> = [];
    for (const group of groups) {
      for (let index = 0; index < group.vals.length && rows.length < MAX_SPC_REPORT_DETAIL_ROWS; index++) {
        // ANOVA 原始观测表的首列是「组内序号」；t2 的原始表才是「组名」在前。
        // 两者不能共用 boundedGroupedValueRows 的列序，否则演示 ANOVA
        // 会在导出中把因子名写进「组内序号」列。
        rows.push([index + 1, group.name, raw(group.vals[index])]);
      }
      if (rows.length >= MAX_SPC_REPORT_DETAIL_ROWS) break;
    }
    return rows;
  }

  type Cursor = { group: number; index: number; row: number };
  const heap: Cursor[] = [];
  const less = (left: Cursor, right: Cursor) => left.row < right.row
    || (left.row === right.row && left.group < right.group);
  const push = (cursor: Cursor) => {
    heap.push(cursor);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!less(heap[index], heap[parent])) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
  };
  const pop = (): Cursor | undefined => {
    const first = heap[0];
    const last = heap.pop();
    if (!first || !last || heap.length === 0) return first;
    heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && less(heap[left], heap[smallest])) smallest = left;
      if (right < heap.length && less(heap[right], heap[smallest])) smallest = right;
      if (smallest === index) break;
      [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
      index = smallest;
    }
    return first;
  };

  groups.forEach((group, groupIndex) => {
    const first = group.rowIndices?.[0];
    if (first != null) push({ group: groupIndex, index: 0, row: first });
  });
  const rows: Array<Array<string | number>> = [];
  while (heap.length > 0 && rows.length < MAX_SPC_REPORT_DETAIL_ROWS) {
    const cursor = pop()!;
    const group = groups[cursor.group];
    rows.push([cursor.row + 1, group.name, raw(group.vals[cursor.index])]);
    const nextIndex = cursor.index + 1;
    const nextRow = group.rowIndices?.[nextIndex];
    if (nextRow != null) push({ group: cursor.group, index: nextIndex, row: nextRow });
  }
  return rows;
}

function boundedViolationRows(
  violations: ReadonlySet<number>,
  pointCount: number,
  description: string,
): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [];
  for (let index = 0; index < pointCount && rows.length < MAX_SPC_REPORT_DETAIL_ROWS; index++) {
    if (violations.has(index)) rows.push([index + 1, description]);
  }
  return rows;
}

function violationCountsByStage(
  violations: ReadonlySet<number>,
  segments: ReadonlyArray<{ start: number; end: number }>,
): number[] {
  const counts = new Array<number>(segments.length).fill(0);
  // Set 的插入顺序可能受多条准则先后影响，不假定点号已排序；每点二分定位阶段，
  // 仍将旧实现“每段展开整个 Set”的 O(S×V) 收口为 O(V log S)。
  for (const point of violations) {
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const segment = segments[middle];
      if (point < segment.start) high = middle - 1;
      else if (point > segment.end) low = middle + 1;
      else {
        counts[middle]++;
        break;
      }
    }
  }
  return counts;
}
const dispositionLabel = (value: string) => ({
  none: '无不合格品', unrecorded: '未记录处置状态', pending: '已隔离，待负责部门处置', reworked: '已返工并按要求复验',
  replaced: '已替换', scrapped: '已报废', concession: '已批准让步接收',
}[value] ?? '未记录');

function unrunPayload(kind: string, title: string, subtitle: string, reason: string, usesWorksheet?: boolean): AnalysisReportPayload {
  return {
    kind,
    title,
    subtitle,
    generatedAt: now(),
    summary: ['当前分析未运行，未生成统计结论。'],
    warnings: [reason],
    tables: [],
    charts: [],
    usesWorksheet,
  };
}

function buildSummaryPayload(): AnalysisReportPayload {
  const app = useApp.getState();
  const data = useData.getState();
  const selected = resolveNumericColumn(data.model, app.activeVar);
  const pendingCount = data.pendingCells.filter((cell) => cell.col === selected.index).length;
  if (pendingCount > 0) {
    return unrunPayload(
      'summary',
      '描述性统计专项报告',
      `${data.model.name} · ${selected.name}`,
      `「${selected.name}」还有 ${pendingCount} 个待录入单元格；系统未把占位值作为实测值汇总。`,
      true,
    );
  }
  const d = computeDescriptive(selected.values);
  const normality = d.adAvailable
    ? `Anderson-Darling A²=${fmt(d.ad.a2star, 4)}，P=${fmt(d.ad.p, 6)}；${d.ad.normal ? '未拒绝正态假设' : '显著偏离正态'}。`
    : `当前 N=${d.n}，不足以运行 Anderson-Darling 正态检验。`;
  const rawSummaryRows = Math.min(selected.values.length, MAX_SPC_REPORT_DETAIL_ROWS);
  return {
    kind: 'summary',
    usesWorksheet: true,
    title: '描述性统计专项报告',
    subtitle: `${data.model.name} · 变量 ${selected.name} · N=${d.n}`,
    generatedAt: now(),
    summary: [
      `${selected.name}：均值 ${fmt(d.mean, 6)}，标准差 ${fmt(d.stdev, 6)}，中位数 ${fmt(d.median, 6)}。`,
      normality,
    ],
    warnings: d.stdev === 0
      ? ['该变量没有观测变异；正态曲线、变异系数和基于方差的推断不具备解释意义。']
      : d.adAvailable && !d.ad.normal
        ? ['数据显著偏离正态；使用正态能力或参数检验前应核查分布、异常点或采用适当变换/非参数方法。']
        : [],
    tables: [
      {
        title: '描述性统计量',
        headers: ['变量', 'N', '均值', '标准差', 'SE 均值', '最小值', 'Q1', '中位数', 'Q3', '最大值', 'IQR'],
        rows: [[selected.name, d.n, fmt(d.mean, 8), fmt(d.stdev, 8), fmt(d.seMean, 8), fmt(d.min, 8), fmt(d.q1, 8), fmt(d.median, 8), fmt(d.q3, 8), fmt(d.max, 8), fmt(d.iqr, 8)]],
      },
      {
        title: '用于汇总的原始观测',
        headers: ['工作表行', selected.name],
        rows: (() => { const shown = selected.values.slice(0, rawSummaryRows); const raw = rawFmt(shown, 10); return shown.map((value, index) => [index + 1, raw(value)]); })(),
        totalRows: selected.values.length,
        note: boundedReportTableNote(
          '本报告一次只使用一个数值列，不会展平或合并其他量纲的变量。',
          selected.values.length,
          rawSummaryRows,
        ),
      },
    ],
    charts: [
      svgChart('直方图与正态曲线', <Histogram T={T} data={selected.values} mu={d.mean} sigmaWithin={d.stdev} sigmaOverall={d.stdev} lsl={null} usl={null} tgt={d.mean} tgtLabel="均值" bins={13} h={300} />, 960, 300),
      svgChart('正态概率图', <NormalProbPlot T={T} data={selected.values} h={300} />, 960, 300),
    ],
  };
}

function buildAqlPayload(): AnalysisReportPayload {
  const app = useApp.getState();
  // STORE-09/M5:账本损坏或被隔离时，内存里只有默认空账本(正常检验、0 条记录)。照常生成
  // 会产出一份「看似正常的空追溯账本」，与拒绝 .qproj 导出同理，属于伪造可追溯证据 → 拒绝。
  if (app.aqlLedgerFault !== null) {
    throw new Error('AQL 责任账本已损坏/被隔离，本报表无法反映历史批次记录，已拒绝生成；请先按 AQL 页横幅恢复账本');
  }
  const report = buildAqlReportData(app.aqlLot, app.aqlLevel, app.aqlAQL, app.aqlSwitch, app.aqlRegime);
  const p = report.plan;
  const latest = report.latestRecord;
  const summary = [
    `${report.stateLabel} · ${report.sourceTable} · 初始字码 ${report.initialCode} → 执行字码 ${p.code}`,
    p.fullInspect
      ? `查表样本量达到批量，执行 100% 全检：N=${p.n}，Ac=${p.ac}，Re=${p.re}`
      : report.regime === 'per100'
        ? `抽样方案 n=${p.n}，Ac=${p.ac}，Re=${p.re}(每百单位不合格数体系,d 可大于 n);生产方风险 α=${fmt(report.producerRiskPct, 2)}%,RQL(β=10%)=λ ${report.rqlPer100 == null ? '—' : fmt(report.rqlPer100, 1)}(每百单位不合格数)`
        : `抽样方案 n=${p.n}，Ac=${p.ac}，Re=${p.re}；生产方风险 α=${fmt(report.producerRiskPct, 2)}%，RQL(β=10%)=${fmt(report.rqlPct, 2)}%`,
    latest
      ? `最近批次 ${latest.batchId}：抽检/全检 ${latest.sampleSize} 件，不合格 ${latest.nonconforming} 件，判定${latest.decision === 'accepted' ? '接收' : '不接收'}，检验人 ${latest.inspector}`
      : '尚未记录实际批次检验结果；当前仅为方案设计结果。',
  ];
  const warnings = [
    report.suspended ? '加严检验累计 5 批不接收，抽样检验已暂停；须确认纠正措施有效后才能恢复。' : '',
    p.fullInspect
      ? '本批执行 100% 全检；批接收仍按当前 Ac/Re 判定。发现的不合格品须逐件隔离并按负责部门要求返工、替换、报废或批准处置，批接收不等于放行不合格品。'
      : '',
    report.state === 'normal' && report.switchingScore >= 30 && (!report.productionSteady || !report.reducedApproved)
      ? '转移得分已达到 30，但生产稳定/负责部门批准条件未同时满足，不能转放宽检验。'
      : '',
    // G19 尾巴(CORE-06):记录链审计的 legacy 标记必须随报告披露，不能只停在数据层。
    ...(report.ledgerAudit.status === 'legacy'
      ? report.ledgerAudit.notes.map((note) => `责任账本记录链核对（旧账本兼容）：${note}。`)
      : []),
    report.ledgerAudit.status === 'mismatch'
      ? `责任账本记录链核对未通过：${report.ledgerAudit.detail}。`
      : '',
  ].filter(Boolean);
  const charts = p.fullInspect || report.suspended ? [] : report.regime === 'per100'
    ? [svgChart(
        'OC 特性曲线（每百单位不合格数）',
        <OcCurvePer100 T={T} plan={p} aql={report.aql} rqlLambda={report.rqlPer100 ?? undefined} />,
        960,
        330,
        '泊松 OC 曲线；横轴 λ 为每百单位不合格数。AQL 点显示生产方接收概率，RQL 点对应使用方风险 β=10%。',
      )]
    : [svgChart(
        'OC 特性曲线',
        <OcCurveChart T={T} n={p.n} ac={p.ac} pmax={Math.min(1, Math.max(0.1, (report.rqlPct ?? 40) / 80))} aqlP={report.aql / 100} rqlP={report.rqlPct == null ? undefined : report.rqlPct / 100} />,
        960,
        330,
        'AQL 点显示生产方接收概率；RQL 点对应使用方风险 β=10%。',
      )];
  return {
    kind: 'aql',
    title: 'AQL 接收抽样专项报告',
    subtitle: `${report.standard} · ${report.samplingType} · ${report.regime === 'per100' ? '每百单位不合格数' : '百分不合格品'} · 批量 ${report.lot} · 水平 ${report.level} · AQL ${report.aql}`,
    generatedAt: now(),
    summary,
    warnings,
    tables: [
      {
        title: '当前正式抽样方案',
        headers: ['检验状态', '依据主表', '初始字码', '执行字码', '样本量', 'Ac', 'Re', '转移得分'],
        rows: [[report.stateLabel, report.sourceTable, report.initialCode, p.code, p.n, p.ac, p.re, report.switchingScore]],
      },
      {
        title: '实际批次检验与追溯记录',
        headers: ['时间', '批次号', '检验人', '初检/复验', '批量 N', '水平', 'AQL', '质量表示', '状态', '主表', '初始字码', '执行字码', '检验量', '全检', 'Ac/Re', '不合格数', '不合格品处置', '判定', '转移后', '得分', '备注'],
        // S-2:人工状态转移记录按发生顺序与批次记录同表留痕(操作人列于「检验人」)。
        rows: report.records.map((record) => isAqlTransitionRecord(record) ? [
          record.inspectedAt, '（状态转移）', record.inspector, '人工转移',
          '—', '—', '—', '—', record.stateBefore, '—', '—', '—',
          '—', '—', '—', '—', '—',
          '—', record.stateAfter, record.switchingScoreAfter,
          `${aqlTransitionActionLabel(record.action)}；${aqlTransitionConditionText(record)}；转移前得分 ${record.switchingScoreBefore}；${record.note}`,
        ] : [
          record.inspectedAt, record.batchId, record.inspector, record.originalInspection ? '初检' : '复验',
          record.lot, record.level, record.aql, record.regime === 'per100' ? '每百单位不合格数' : '百分不合格品', record.stateBefore, record.sourceTable, record.initialCode, record.finalCode,
          record.sampleSize, record.fullInspection ? '是' : '否', `${record.acceptanceNumber}/${record.rejectionNumber}`,
          record.nonconforming, dispositionLabel(record.nonconformingDisposition),
          record.decision === 'accepted' ? '接收' : '不接收', record.stateAfter, record.switchingScoreAfter, record.note,
        ]),
        note: '复验批保留追溯记录，但不计入 GB/T 2828.1 第 9.3 条转移规则。「（状态转移）」行为管理条件勾选/取消、因其他条件恢复正常检验或暂停后确认纠正有效恢复加严检验引起的人工状态转移，检验人列为操作人。',
      },
    ],
    charts,
  };
}

function buildAnovaPayload(): AnalysisReportPayload {
  const app = useApp.getState();
  const data = useData.getState();
  const M = data.model;
  const rows = M.subs.map((sub) => sub.vals);
  const eligibleText = data.textCols.filter((column) => isDoeAnalysisColumn(column.name));
  const mode = M.isDemo ? null : resolveAnovaMode(
    app.anovaMode,
    M.colNames,
    rows,
    eligibleText.length,
    app.anovaRespName,
    app.anovaFactorName,
  );
  let groups: AnovaGroup[];
  let responseName: string;
  let factorName: string;
  let modeLabel: string;
  // “查看示例”只在当前数据确实没有可分析形态时生效；一旦工作表变为可分析，
  // 页面会显示真实结果，保存/导出也必须同步切回真实数据。
  const isDemo = M.isDemo || (mode === null && app.anovaShowDemo);
  if (isDemo) {
    groups = anovaGroups();
    responseName = '直径';
    factorName = '设备';
    modeLabel = '内置演示（非用户数据）';
  } else {
    if (!mode) {
      return unrunPayload('anova', '单因子 ANOVA 专项报告', M.name, '当前数据不能构成至少 2 组、每组至少 2 个观测的有效单因子 ANOVA。');
    }
    const pendingCount = countAnovaPendingCells(
      mode, M.colNames, rows, app.anovaRespName, app.anovaFactorName, data.pendingCells,
    );
    if (pendingCount > 0) {
      return unrunPayload('anova', '单因子 ANOVA 专项报告', M.name, `当前 ANOVA 使用列中还有 ${pendingCount} 个待录入单元格；已拦截将占位值当作实测值的 F/P 计算。`);
    }
    const input = buildAnovaInput(mode, M.colNames, rows, eligibleText, app.anovaRespName, app.anovaFactorName);
    responseName = input.roles.responseName;
    factorName = input.roles.factorName;
    const built = input.groups;
    if (!built) {
      return unrunPayload('anova', '单因子 ANOVA 专项报告', `${responseName} vs ${factorName}`, '所选因子/响应角色无法形成有效分组；请确认因子至少有 2 个水平，且每个水平至少 2 个观测。');
    }
    if (mode === 'wide' && wideScaleDisparate(built)) {
      return unrunPayload('anova', '单因子 ANOVA 专项报告', M.name, '宽表各列量纲悬殊，页面已拦截无统计意义的组间比较；请改用数值因子模式或选择同量纲列。');
    }
    groups = built;
    modeLabel = mode === 'stacked' ? '长表分组' : mode === 'numfactor' ? '数值因子' : '宽表各列一组';
  }
  const report = buildAnovaStructuredReport({ responseName, factorName, groups });
  const factor = report.sources[0];
  const error = report.sources[1];
  const residuals = report.diagnostics.residuals;
  const hasWorksheetRows = groups.every((group) => group.rowIndices?.length === group.vals.length);
  const observationCount = groups.reduce((sum, group) => sum + group.vals.length, 0);
  const observationRows = boundedAnovaObservationRows(groups, hasWorksheetRows);
  const residualRowCount = Math.min(residuals.length, MAX_SPC_REPORT_DETAIL_ROWS);
  const groupRowCount = Math.min(report.groups.length, MAX_SPC_REPORT_DETAIL_ROWS);
  const groupChartNote = groupedPlotWindow(groups).note;
  return {
    kind: 'anova',
    usesWorksheet: !isDemo,
    title: '单因子 ANOVA 专项报告',
    subtitle: `${responseName} vs ${factorName} · ${modeLabel}`,
    generatedAt: now(),
    summary: [
      report.significant
        ? `F(${factor.df}, ${error.df})=${fmt(factor.f, 4)}，P=${fmt(factor.p, 6)}；当前样本支持至少一组总体均值不同（α=${fmt(report.alpha, 2)}）。`
        : `F(${factor.df}, ${error.df})=${fmt(factor.f, 4)}，P=${fmt(factor.p, 6)}；当前样本未提供组间均值不同的充分证据（α=${fmt(report.alpha, 2)}）。这不等于各组均值相同、等效或来自同一总体。`,
      `残差按${report.diagnostics.worksheetOrder ? '原工作表采集行序' : '分组顺序'}输出；组均值区间采用 ANOVA 合并误差 MSE。`,
    ],
    warnings: [
      isDemo ? '本报告使用内置的「设备 A/B/C × 直径」演示研究，不得当作用户数据结论。' : '',
      groups.some((group) => group.vals.length < 5) ? '存在样本量小于 5 的组，检验功效有限，建议补充重复观测。' : '',
      groupChartNote ? `分组图${groupChartNote}可在分析页翻页查看其他组。` : '',
    ].filter(Boolean),
    tables: [
      {
        title: '用于 ANOVA 的原始观测',
        headers: [hasWorksheetRows ? '工作表行' : '组内序号', factorName, responseName],
        rows: observationRows,
        totalRows: observationCount,
        note: boundedReportTableNote(
          '该表保留实际分组角色和响应值，可用于复核方差分析。',
          observationCount,
          observationRows.length,
        ),
      },
      {
        title: '方差分析表',
        headers: ['来源', 'DF', 'SS', 'MS', 'F', 'P'],
        rows: report.sources.map((source) => [source.source, source.df, fmt(source.ss, 6), fmt(source.ms, 6), fmt(source.f, 5), fmt(source.p, 6)]),
      },
      {
        title: '分组描述统计与合并误差置信区间',
        headers: ['组', 'N', '均值', '标准差', '95% CI 下限', '95% CI 上限'],
        rows: report.groups.slice(0, groupRowCount).map((group) => [group.name, group.n, fmt(group.mean), fmt(group.stDev), fmt(group.ciLow), fmt(group.ciHigh)]),
        totalRows: report.groups.length,
      },
      {
        title: '残差诊断数据',
        headers: ['观测序', '拟合值', '残差'],
        rows: residuals.slice(0, residualRowCount).map((residual, index) => [index + 1, fmt(report.diagnostics.fits[index]), fmt(residual)]),
        totalRows: residuals.length,
      },
    ],
    charts: [
      svgChart('个体值图', <IndividualValuePlot T={T} groups={groups} />, 960, 320, groupChartNote || undefined),
      svgChart('均值与 95% 置信区间', <IntervalPlot T={T} groups={groups} pooledError={{ mse: error.ms ?? 0, df: error.df }} />, 960, 320, groupChartNote || undefined),
      svgChart('残差正态概率图', <NormalProbPlot T={T} data={residuals} h={280} />, 960, 280),
    ],
  };
}

function buildHypothesisPayload(): AnalysisReportPayload {
  const app = useApp.getState();
  const data = useData.getState();
  const M = data.model;
  const indexFor = (name: string | null, fallback: number) => {
    const index = name ? M.colNames.indexOf(name) : -1;
    return index >= 0 ? index : fallback;
  };
  const pendingIn = (columns: number[]) => data.pendingCells.filter((cell) =>
    cell.row >= 0 && cell.row < M.k && columns.includes(cell.col)).length;

  if (app.hypoTab === 't1') {
    const column = indexFor(app.t1ColName, 0);
    const columnName = M.colNames[column] ?? '测量值';
    const mu0 = app.t1Mu0 ?? app.tgt;
    const pending = pendingIn([column]);
    if (pending > 0) return unrunPayload('t1', '单样本 t 检验专项报告', `${columnName} vs μ₀=${fmt(mu0, 8)}`, `所选测量列还有 ${pending} 个待录入单元格。`);
    const values = M.subs.map((sub) => sub.vals[column]);
    const rawRowCount = Math.min(values.length, MAX_SPC_REPORT_DETAIL_ROWS);
    try {
      const result = oneSampleT(values, mu0);
      return {
        kind: 't1', usesWorksheet: true, title: '单样本 t 检验专项报告', subtitle: `${columnName} vs 目标 μ₀=${fmt(mu0, 8)}`, generatedAt: now(),
        summary: [result.significant
          ? `t(${fmt(result.df, 2)})=${fmt(result.t, 5)}，P=${fmt(result.p, 6)}；当前样本支持总体均值偏离目标（双侧 α=0.05）。`
          : `t(${fmt(result.df, 2)})=${fmt(result.t, 5)}，P=${fmt(result.p, 6)}；当前样本未提供总体均值偏离目标的充分证据（双侧 α=0.05）。这不等于过程已对准目标或已满足等效性要求。`],
        warnings: M.isDemo ? ['当前为出厂演示数据集，不得当作用户过程结论。'] : [],
        tables: [
          {
            title: '原始样本', headers: ['观测', columnName],
            rows: (() => { const shown = values.slice(0, rawRowCount); const raw = rawFmt(shown); return shown.map((value, index) => [index + 1, raw(value)]); })(),
            totalRows: values.length,
          },
          { title: '检验结果', headers: ['N', '均值', 'μ₀', 't', 'df', 'P', '95% CI 下限', '95% CI 上限', 'SE'], rows: [[values.length, fmt(result.estimate), fmt(mu0), fmt(result.t), fmt(result.df, 2), fmt(result.p, 6), fmt(result.ciLow), fmt(result.ciHigh), fmt(result.se)]] },
        ],
        charts: [svgChart(`${columnName} 的箱线图`, <BoxPlot T={T} groups={[{ name: columnName, vals: values }]} />, 960, 320)],
      };
    } catch (error) {
      return unrunPayload('t1', '单样本 t 检验专项报告', columnName, `无法计算：${(error as Error).message}`);
    }
  }

  if (app.hypoTab === 't2') {
    if (M.colNames.length < 2) {
      return unrunPayload(
        't2',
        '双样本 t 检验专项报告',
        M.name,
        '双样本 t 检验需要两个不同的数值样本列；当前工作表只有 1 个数值列。请导入第二组样本或将两组数据分别放入两列。系统不会改用内置演示数据。',
        true,
      );
    }
    const first = indexFor(app.t2ColAName, 0);
    const namedSecond = indexFor(app.t2ColBName, 1);
    const second = namedSecond === first ? (first === 0 ? 1 : 0) : namedSecond;
    const groups = [
      { name: M.colNames[first], vals: M.subs.map((sub) => sub.vals[first]) },
      { name: M.colNames[second], vals: M.subs.map((sub) => sub.vals[second]) },
    ];
    const pending = pendingIn([first, second]);
    if (pending > 0) return unrunPayload('t2', '双样本 t 检验专项报告', `${groups[0].name} vs ${groups[1].name}`, `所选样本列还有 ${pending} 个待录入单元格。`);
    try {
      const result = twoSampleT(groups[0].vals, groups[1].vals);
      const observationCount = groups.reduce((sum, group) => sum + group.vals.length, 0);
      const sampleRows = boundedGroupedValueRows(groups);
      return {
        kind: 't2', usesWorksheet: true, title: '双样本 t 检验（Welch）专项报告', subtitle: `${groups[0].name} vs ${groups[1].name}`, generatedAt: now(),
        summary: [result.significant
          ? `t(${fmt(result.df, 2)})=${fmt(result.t, 5)}，P=${fmt(result.p, 6)}；当前样本支持两组总体均值不同（Welch 不等方差，双侧 α=0.05）。`
          : `t(${fmt(result.df, 2)})=${fmt(result.t, 5)}，P=${fmt(result.p, 6)}；当前样本未提供两组总体均值不同的充分证据（Welch 不等方差，双侧 α=0.05）。这不等于两组均值相同或等效。`],
        warnings: M.isDemo ? ['当前为出厂演示数据集。'] : [],
        tables: [
          {
            title: '原始样本', headers: ['样本', '组内序号', '观测'], rows: sampleRows,
            totalRows: observationCount,
          },
          { title: '检验结果', headers: ['均值差', 't', 'df', 'P', '95% CI 下限', '95% CI 上限', 'SE'], rows: [[fmt(result.estimate), fmt(result.t), fmt(result.df, 2), fmt(result.p, 6), fmt(result.ciLow), fmt(result.ciHigh), fmt(result.se)]] },
        ],
        charts: [svgChart('双样本箱线图', <BoxPlot T={T} groups={groups} />, 960, 320)],
      };
    } catch (error) {
      return unrunPayload('t2', '双样本 t 检验专项报告', `${groups[0].name} vs ${groups[1].name}`, `无法计算：${(error as Error).message}`);
    }
  }

  const xIndex = indexFor(app.regXName, 0);
  const namedY = indexFor(app.regYName, M.colNames.length >= 2 ? 1 : 0);
  if (M.colNames.length < 2 || xIndex === namedY) {
    return unrunPayload('reg', '相关与回归专项报告', M.name, M.colNames.length < 2 ? '线性回归需要至少 2 个数值列。' : 'X 与 Y 不能是同一列。');
  }
  const pending = pendingIn([xIndex, namedY]);
  if (pending > 0) return unrunPayload('reg', '相关与回归专项报告', M.name, `所选 X/Y 列还有 ${pending} 个待录入单元格。`);
  const xs = M.subs.map((sub) => sub.vals[xIndex]);
  const ys = M.subs.map((sub) => sub.vals[namedY]);
  try {
    const result = linearRegression(xs, ys);
    const xName = M.colNames[xIndex];
    const yName = M.colNames[namedY];
    return {
      kind: 'reg', usesWorksheet: true, title: '线性回归专项报告', subtitle: `${yName} vs ${xName}`, generatedAt: now(),
      summary: [result.significant
        ? `${yName} = ${fmt(result.intercept, 6)} ${result.slope >= 0 ? '+' : '−'} ${fmt(Math.abs(result.slope), 6)} × ${xName}；R²=${fmt(result.r2, 5)}，P=${fmt(result.p, 6)}，当前样本支持显著线性关系。`
        : `${yName} = ${fmt(result.intercept, 6)} ${result.slope >= 0 ? '+' : '−'} ${fmt(Math.abs(result.slope), 6)} × ${xName}；R²=${fmt(result.r2, 5)}，P=${fmt(result.p, 6)}。当前样本未提供显著线性关系的充分证据；这不等于 X 与 Y 相互独立，也不能排除非线性关系。`],
      warnings: M.isDemo ? ['当前为出厂演示数据集。'] : [],
      tables: [
        {
          title: '原始 X/Y 观测', headers: ['行', xName, yName],
          rows: (() => { const shownX = xs.slice(0, MAX_SPC_REPORT_DETAIL_ROWS); const rawX = rawFmt(shownX); const rawY = rawFmt(ys.slice(0, MAX_SPC_REPORT_DETAIL_ROWS)); return shownX.map((value, index) => [index + 1, rawX(value), rawY(ys[index])]); })(),
          totalRows: xs.length,
        },
        { title: '回归统计', headers: ['N', '相关系数 r', 'R²', '截距', '斜率', 't', 'df', 'P'], rows: [[result.n, fmt(result.r), fmt(result.r2), fmt(result.intercept), fmt(result.slope), fmt(result.t), result.df, fmt(result.p, 6)]] },
      ],
      charts: [svgChart('散点图与最小二乘回归线', <ScatterPlot T={T} xs={xs} ys={ys} slope={result.slope} intercept={result.intercept} xLabel={xName} yLabel={yName} />, 960, 320)],
    };
  } catch (error) {
    return unrunPayload('reg', '相关与回归专项报告', M.name, `无法计算：${(error as Error).message}`);
  }
}

function doeRunMetadata(colNames: string[], rows: number[][], textCols: { name: string; values: string[] }[]): DoeRunMetadata[] | undefined {
  const normalize = (name: string) => name.trim().toLowerCase().replace(/[ _-]/g, '');
  const findNumeric = (aliases: string[]) => colNames.findIndex((name) => aliases.includes(normalize(name)));
  const standard = findNumeric(['标准序', '标准顺序', 'stdorder', 'standardorder']);
  const run = findNumeric(['运行序', '运行顺序', 'runorder']);
  const block = findNumeric(['区组', '区块', 'block', 'blocks']);
  const pointType = textCols.find((column) => ['点类型', 'pointtype', 'pttype'].includes(normalize(column.name)));
  const numericPointType = findNumeric(['点类型', 'pointtype', 'pttype']);
  if (standard < 0 && run < 0 && block < 0 && !pointType && numericPointType < 0) return undefined;
  return rows.map((row, index) => ({
    standardOrder: standard >= 0 ? row[standard] : undefined,
    runOrder: run >= 0 ? row[run] : index + 1,
    block: block >= 0 ? row[block] : undefined,
    pointType: pointType?.values[index] ?? (numericPointType >= 0
      ? (row[numericPointType] === 0 ? '中心点' : '因子点')
      : undefined),
  }));
}

/** 页面与专项报告共用的 DOE 残差图语义：概率图与直方图共享残差横轴；
 * “与拟合值/与顺序”保留各自横轴变量。非有限删后残差只从绘图层排除，不改统计表。 */
function doeResidualCharts(
  residuals: number[],
  fits: number[],
  runOrder: number[],
  residualLabel: string,
): AnalysisReportChart[] {
  const finite = residuals.map((value, index) => ({ value, index })).filter((item) => Number.isFinite(item.value));
  if (!finite.length) return [];
  const values = finite.map((item) => item.value);
  const fitValues = finite.map((item) => fits[item.index]);
  const orderValues = finite.map((item) => runOrder[item.index] ?? item.index + 1);
  const scale = residualAxisScale(values);
  return [
    svgChart('残差图 · 正态概率图', <NormalProbPlot T={T} data={values} h={280} xLabel={residualLabel} xDomain={scale.domain} xTicks={scale.ticks} />, 960, 280),
    svgChart('残差图 · 直方图', <MiniHist T={T} data={values} h={280} title={`${residualLabel}分布`} xLabel={residualLabel} xDomain={scale.domain} xTicks={scale.ticks} />, 960, 280),
    svgChart('残差图 · 与拟合值', <ScatterPlot T={T} xs={fitValues} ys={values} slope={0} intercept={0} xLabel="拟合值" yLabel={residualLabel} h={280} />, 960, 280),
    svgChart('残差图 · 与顺序', <ScatterPlot T={T} xs={orderValues} ys={values} slope={0} intercept={0} xLabel="观测值顺序" yLabel={residualLabel} h={280} />, 960, 280),
  ];
}

function doeRandomizationAudit(datasetName: string): string {
  const seeded = datasetName.match(/_(自动|固定)seed-(\d+)$/);
  if (seeded) return `随机化审计：${seeded[1]}种子模式，实际 seed=${seeded[2]}（记录于工作表名称）。`;
  if (/_未随机$/.test(datasetName)) return '随机化审计：未随机化，标准序与运行序相同（记录于工作表名称）。';
  return `随机化审计：来源工作表“${datasetName}”未包含平台生成的随机化模式/seed 元数据。`;
}

function buildDoePayload(): AnalysisReportPayload {
  const app = useApp.getState();
  const data = useData.getState();
  const M = data.model;
  if (app.doeTab === 'create') {
    return unrunPayload(
      'doe', '因子试验设计（DOE）专项报告', '当前为「创建因子设计」视图',
      '创建页只在配置设计，尚无分析结果；请先生成设计、录入响应，再切换到「分析因子设计」导出。',
    );
  }
  if (M.isDemo) {
    const demo = analyzeDoe();
    const main = mainEffectMeans();
    // fix2609k:效应/系数以响应尺度判浮点噪声(A×B 的 3.3e-16 按 0 输出,与页面 0.000 同源)
    const demoScale = magnitudeOf(DOE_DESIGN.map((run) => run[3]));
    return {
      kind: 'doe',
      usesWorksheet: false,
      title: '因子试验设计（DOE）专项报告',
      subtitle: '内置 2³ 全因子演示 · 响应 抗拉强度 (MPa) · 非用户数据',
      generatedAt: now(),
      summary: [
        `显著项：${demo.terms.filter((term) => term.sig).map((term) => term.name).join('、') || '无'}。`,
        `Lenth PSE=${fmt(demo.pse)}，显著性参考线 ME=${fmt(demo.me)}。`,
      ],
      warnings: ['本报告使用内置「温度/压力/时间 → 抗拉强度」演示数据，不得当作用户实验结论。'],
      tables: [
        {
          title: '效应与系数',
          headers: ['项', '效应', '系数', '显著'],
          rows: demo.terms.map((term) => [term.name, fmt(term.v, 4, demoScale), fmt(term.coef, 4, demoScale), term.sig ? '是' : '否']),
        },
        {
          title: '演示设计矩阵',
          headers: ['运行', 'A 温度', 'B 压力', 'C 时间', '抗拉强度'],
          rows: DOE_DESIGN.map((run, index) => [index + 1, run[0], run[1], run[2], run[3]]),
        },
      ],
      charts: [
        svgChart('主效应图', <MainEffects T={T} factors={main} />, 960, 230),
        svgChart('效应帕累托图', <EffectsBar T={T} terms={demo.terms.map((term) => ({ name: term.name, abs: term.abs }))} refLine={demo.me} />, 960, 290),
      ],
    };
  }
  const rows = M.subs.map((sub) => sub.vals);
  // 716-R3 自查:与分析页同用 Wide 解析(上限 7)。旧 resolveDoeColumns 截到 4 因子会让
  // 2^(5-1) 的 E 效应在正式报告里冒充 A×B×C×D。
  const { factorIdx, respIdx } = resolveDoeColumnsWide(M.colNames, app.doeFactorCols, app.doeRespCol, MAX_FRACTIONAL_FACTORS);
  if (factorIdx.length < 2 || respIdx < 0) {
    return unrunPayload('doe', '因子试验设计（DOE）专项报告', M.name, '需要至少 2 个合法因子列和 1 个响应列；标准序、运行序、区组及旧的 DOE 输出列不会被当作因子。');
  }
  const response = rows.map((row) => row[respIdx]);
  const blocks = resolveDoeBlockValues(M.colNames, rows, data.textCols);
  const doeFacs = factorIdx.map((index) => ({ name: M.colNames[index], values: rows.map((row) => row[index]) }));
  const detected = doeFacs.length <= 4
    ? detectFactorial(doeFacs, response, { blocks })
    : detectFractionalFactorial(doeFacs, response, { blocks });
  if (!detected.ok) {
    // 716-R3:两水平识别失败时按一般全因子回落,与分析页/保存卡同口径
    const gen = detectGeneralFactorial(
      factorIdx.map((index) => ({ name: M.colNames[index], values: rows.map((row) => row[index]) })),
      response,
    );
    if (gen.ok) {
      const genPending = data.pendingCells.filter((cell) => cell.col === respIdx).length;
      if (genPending > 0 || new Set(response).size < 2) {
        return unrunPayload('doe', '因子试验设计（DOE）专项报告', M.name,
          genPending > 0 ? `响应列还有 ${genPending} 个待录入单元格。` : '响应列没有变异,无法估计因子效应。');
      }
      const gr = analyzeGeneralFactorial(gen.design);
      const metadata = doeRunMetadata(M.colNames, rows, data.textCols);
      const residualCharts = doeResidualCharts(
        gr.residuals,
        gr.fits,
        gr.residuals.map((_, index) => metadata?.[index]?.runOrder ?? index + 1),
        '残差',
      );
      const fmtP = (value: number | null) => value == null ? '—' : value < 0.001 ? '<0.001' : fmt(value, 3);
      // 3b G21 尾巴:平方和/均方以总平方和为尺度、F 为无量纲比值(尺度 1)判浮点噪声——完全可加的
      // 数据里 A×B 的 Adj SS 不再印成 1.388e-17、F 不再印成 3.47e-16(与定点 0.0000 同义)。
      const ssScale = Math.abs(gr.total.adjSS);
      return {
        kind: 'doe',
        title: '因子试验设计（DOE）专项报告 · 一般全因子',
        subtitle: `${M.name} · ${M.colNames[respIdx]} · ${gen.design.factorNames.join(' / ')} · ${gr.nRuns} 次运行`,
        generatedAt: now(),
        summary: [
          gr.rows.some((row) => row.sig)
            ? `显著项(α=0.05):${gr.rows.filter((row) => row.sig).map((row) => row.name).join('、')};R² = ${fmt(gr.r2 * 100, 1)}%。`
            : `未检出显著项(α=0.05);R² = ${fmt(gr.r2 * 100, 1)}%。`,
          ...(gr.interactionNote ? [gr.interactionNote] : []),
          doeRandomizationAudit(M.name),
        ],
        warnings: gr.inestimableTerms?.length ? [`以下项因缺格/别名不可估计:${gr.inestimableTerms.join('、')}`] : [],
        tables: [{
          title: '方差分析(Adj SS,与 Minitab GLM 默认口径一致)',
          headers: ['来源', 'DF', 'Adj SS', 'Adj MS', 'F', 'P'],
          rows: [
            ...gr.rows.map((row) => [row.name, row.df, fmt(row.adjSS, 4, ssScale), row.adjMS == null ? '—' : fmt(row.adjMS, 4, ssScale), row.f == null ? '—' : fmt(row.f, 2, 1), fmtP(row.p)]),
            ['误差', gr.error.df, fmt(gr.error.adjSS, 4, ssScale), gr.error.adjMS == null ? '—' : fmt(gr.error.adjMS, 4, ssScale), '', ''],
            ['合计', gr.total.df, fmt(gr.total.adjSS, 4), '', '', ''],
          ],
          note: '残差诊断已随本专项报告导出；概率图与直方图共享残差横轴。',
        }],
        charts: residualCharts,
      };
    }
    return unrunPayload('doe', '因子试验设计（DOE）专项报告', M.name, `无法识别当前因子设计：${detected.reason}`);
  }
  const pendingCount = data.pendingCells.filter((cell) => cell.col === respIdx).length;
  if (pendingCount > 0 || new Set(response).size < 2) {
    return unrunPayload(
      'doe',
      '因子试验设计（DOE）专项报告',
      `${M.colNames[respIdx]} · ${detected.design.factorNames.join(' / ')}`,
      pendingCount > 0
        ? `响应列还有 ${pendingCount} 个待录入单元格；页面已拦截将占位值当作实测值的分析。`
        : '响应列没有变异，无法估计因子效应；请确认已录入实测响应。',
    );
  }
  const allTerms = factorialModelTerms(detected.design.factorNames);
  // 与分析页同口径:5 因子以上默认仅主效应+二因子交互入模
  const available = detected.design.factorNames.length > 4
    ? allTerms.filter((term) => term.split('×').length <= 2)
    : allTerms;
  const storedTerms = app.doeModelTerms?.filter((term) => available.includes(term));
  const selected = storedTerms?.length
    ? factorialHierarchyClosure(detected.design.factorNames, storedTerms, available)
    : available;
  const result = (detected.design.factorNames.length <= 4 ? analyzeFactorial : analyzeFractionalFactorial)(detected.design, {
    terms: selected,
    includeCurvature: app.doeIncludeCurvature,
  });
  const responseName = M.colNames[respIdx];
  if (result.terms.length === 0) {
    const aliases = result.aliases?.map((alias) =>
      alias.relation === 'same' ? `${alias.term} = ${alias.with}`
        : alias.relation === 'opposite' ? `${alias.term} = −${alias.with}`
          : `${alias.term} 与 ${alias.with} 线性相关`).join('；');
    return unrunPayload(
      'doe',
      '因子试验设计（DOE）专项报告',
      `${responseName} · ${detected.design.factorNames.join(' / ')}`,
      `所选模型项全部不可独立估计${aliases ? `：${aliases}` : ''}。请解除完全混杂、增加运行或改选可估计模型项。`,
    );
  }
  const report = buildDoeStructuredReport(detected.design, result, responseName, doeRunMetadata(M.colNames, rows, data.textCols));
  // fix2609k:效应/系数/拟合/残差以响应尺度判浮点噪声,常规数据的 1e-16 残差不印成科学计数
  const responseScale = magnitudeOf(response);
  const main = factorialAdjustedMainMeans(result, detected.design);
  const isT = result.method === 'ttest';
  const finiteT = result.terms.map((term) => Math.abs(term.tStat ?? 0)).filter(Number.isFinite);
  const capT = (finiteT.length ? Math.max(...finiteT) : 1) * 1.5 + 1;
  const bars = result.terms.map((term) => ({ name: term.name, abs: isT ? (Number.isFinite(term.tStat) ? Math.abs(term.tStat!) : capT) : Math.abs(term.effect) }));
  const ref = isT ? tInv(0.975, result.dfResid ?? 1) : (result.me ?? 0);
  const residuals = result.stdResiduals ?? result.residuals;
  const residualCharts = doeResidualCharts(
    residuals,
    result.fits,
    report.runs.map((run) => run.runOrder),
    result.stdResiduals ? '标准化残差' : '残差',
  );
  const optimization = factorialOptimizationDecision(result, detected.design);
  const optimizationTerms = factorialOptimizationTerms(result, detected.design);
  const uniqueSettings = optimization.status === 'unique' && optimization.optimum
    ? optimization.optimum.factorValues.map((value, index) =>
      `${detected.design.factorNames[index]}=${fmt(value, 6)}(${optimization.optimum!.coded[index] > 0 ? '高' : '低'})`).join('、')
    : '';
  const fixedSettings = optimization.status === 'tied'
    ? optimization.fixedCoded?.flatMap((coded, index) => coded == null ? [] : [
      `${detected.design.factorNames[index]}=${fmt(coded > 0 ? detected.design.levels[index].high : detected.design.levels[index].low, 6)}(${coded > 0 ? '高' : '低'})`,
    ]).join('、')
    : '';
  const tiedSettings = optimization.status === 'tied'
    ? optimization.optimum?.ties.slice(0, 4).map((corner) => corner.factorValues.map((value, index) =>
      `${detected.design.factorNames[index]}=${fmt(value, 6)}(${corner.coded[index] > 0 ? '高' : '低'})`).join('、')).join('；')
    : '';
  const optimizationSummary = buildDoeConclusion({
    status: optimization.status,
    aliases: result.aliases,
    hasSignificantInteraction: result.terms.some((term) => term.sig && term.name.includes('×')),
    sigTermNames: optimizationTerms.significantTerms,
    hierarchyParentNames: optimizationTerms.hierarchyParentTerms,
    detail: result.method === 'ttest' ? `残差自由度 ${result.dfResid}` : 'Lenth 检验',
    factorCount: detected.design.factorNames.length,
    respName: responseName,
    settings: optimization.status === 'tied'
      ? `${tiedSettings}${optimization.optimum!.ties.length > 4 ? `；另有 ${optimization.optimum!.ties.length - 4} 个` : ''}`
      : uniqueSettings,
    tieCount: optimization.optimum?.ties.length,
    fixedSettings,
  });
  return {
    kind: 'doe',
    usesWorksheet: true,
    title: '因子试验设计（DOE）专项报告',
    subtitle: `${M.name} · ${report.factors.length} 因子 · ${report.runCount} 运行 · 响应 ${responseName} · ${report.method === 'ttest' ? 't 检验' : 'Lenth 检验'}`,
    generatedAt: now(),
    summary: [
      `模型项 ${report.model.requestedTerms.join('、') || '无'}；${report.model.includeCurvature ? '包含中心点曲率' : '不包含曲率'}；残差自由度 ${report.model.residualDf ?? '—'}。`,
      result.block ? `已将 ${result.block.levels.length} 个区组（DF=${result.block.df}）作为扰动项调整；主效应图为区组等权调整后的模型均值，与区组混杂的交互项不单独解释。` : '主效应图使用当前拟合模型的调整均值；未检测到多区组调整。',
      optimizationSummary,
      doeRandomizationAudit(M.name),
    ],
    warnings: [
      report.model.droppedTerms.length ? `以下项因别名/秩亏不能单独估计并已剔除：${report.model.droppedTerms.join('、')}。` : '',
    ].filter(Boolean),
    tables: [
      {
        title: '效应与系数',
        headers: ['项', '效应', '系数', 't', 'P', '显著'],
        // t 与标准化残差是无量纲统计量:以尺度 1 判浮点噪声(零效应的 t 不再印成 3.277e-15)
        rows: report.coefficients.map((term) => [term.term, fmt(term.effect, 4, responseScale), fmt(term.coefficient, 4, responseScale), fmt(term.t, 4, 1), fmt(term.p, 6), term.significant ? '是' : '否']),
      },
      {
        title: '设计矩阵、拟合与残差',
        headers: ['行', '标准序', '运行序', '区组', '点类型', ...report.factors.map((factor) => factor.name), '观测', '拟合', '残差', '标准化残差'],
        rows: report.runs.slice(0, MAX_SPC_REPORT_DETAIL_ROWS).map((run) => [
          run.row, run.standardOrder ?? '—', run.runOrder, run.block ?? '—', run.pointType,
          ...run.factorValues.map((value) => fmt(value, 6)), fmt(run.observed), fmt(run.fitted, 4, responseScale), fmt(run.residual, 4, responseScale), fmt(run.standardizedResidual, 4, 1),
        ]),
        totalRows: report.runs.length,
      },
      {
        title: '别名与可估计性',
        headers: ['被剔除项', '别名/依赖项', '关系'],
        rows: report.model.aliases.map((alias) => [alias.term, alias.with, alias.relation]),
        note: report.model.aliases.length ? '别名项不能在当前设计中独立估计。' : '当前所选模型项均可估计。',
      },
    ],
    charts: [
      svgChart('主效应图', <MainEffects T={T} factors={main} />, 960, 230),
      svgChart('标准化效应帕累托图', <EffectsBar T={T} terms={bars} refLine={ref} />, 960, 290),
      ...residualCharts,
    ],
  };
}

function buildParetoPayload(): AnalysisReportPayload {
  const app = useApp.getState();
  const model = useData.getState().paretoModel;
  const hasImportedData = !!model && model.rows.length > 0;
  const source = hasImportedData ? model.rows : app.paretoShowDemo ? DEFECTS : null;
  if (!source) {
    return {
      kind: 'pareto',
      title: '帕累托分析专项报告',
      subtitle: '尚未导入缺陷类别与频数数据',
      generatedAt: now(),
      summary: ['当前分析未运行，未生成帕累托结论。'],
      warnings: ['请先导入类别+频数数据，或在页面上明确选择查看内置示例。'],
      tables: [],
      charts: [],
    };
  }
  // 人工审核720：页面、总览与专项报告固定展开全部类别；旧偏好中的 mergeOther 不再影响任何展示端。
  const report = paretoReport({ rows: source, mergeOther: false, threshold: app.paretoThreshold });
  const sourceName = hasImportedData ? model.name : '内置示例（非用户数据）';
  const paretoSourceRows = Math.min(source.length, MAX_SPC_REPORT_DETAIL_ROWS);
  const paretoRankedRows = Math.min(report.rows.length, MAX_SPC_REPORT_DETAIL_ROWS);
  return {
    kind: 'pareto',
    title: '帕累托分析专项报告',
    subtitle: `${sourceName} · ${report.sourceCategoryCount} 个原始类别 · 总计 ${report.total}`,
    generatedAt: now(),
    summary: [report.conclusion],
    warnings: hasImportedData ? [] : ['本报告使用页面当前显示的内置示例，不得作为用户批次数据的质量结论。'],
    tables: [
      {
        title: '导入的原始缺陷数据',
        headers: ['类别', '频数'],
        rows: source.slice(0, paretoSourceRows).map((row) => [row.name, row.count]),
        totalRows: source.length,
        note: boundedReportTableNote(
          hasImportedData ? '统计与图形保留导入时的全部类别，不合并尾部类别。' : '内置演示原始数据。',
          source.length,
          paretoSourceRows,
        ),
      },
      {
        title: '缺陷频数与累计贡献',
        headers: ['类别', '频数', '占比', '累计占比'],
        rows: report.rows.slice(0, paretoRankedRows).map((row) => [row.name, row.count, `${fmt(row.percentage, 2)}%`, `${fmt(row.cumulativePercentage, 2)}%`]),
        totalRows: report.rows.length,
        note: boundedReportTableNote(
          '统计口径固定展开全部类别，未启用尾部类别合并。',
          report.rows.length,
          paretoRankedRows,
        ),
      },
    ],
    charts: [svgChart('帕累托图', <ParetoChart T={T} rows={report.rows.map((row) => ({ name: row.name, count: row.count }))} title={`${hasImportedData ? model.name : '示例数据'} 的 Pareto 图`} />, 960, 300)],
  };
}

function buildFishbonePayload(): AnalysisReportPayload {
  const { data, isDemo } = loadFishboneState();
  const causeCount = data.categories.reduce((sum, category) => sum + category.causes.length, 0);
  return {
    kind: 'fishbone',
    title: '因果图（鱼骨图）专项报告',
    subtitle: `问题：${data.problem} · 6M · ${causeCount} 条原因`,
    generatedAt: now(),
    summary: [`已按人、机、料、法、环、测 6M 结构整理 ${causeCount} 条潜在原因；应结合现场证据验证，不将因果图本身当作根因定论。`],
    warnings: [
      isDemo ? '本报告使用内置“尺寸超差”示例，不得作为用户问题的根因结论。' : '',
      causeCount === 0 ? '当前尚未录入任何潜在原因。' : '',
    ].filter(Boolean),
    tables: [{
      title: '6M 潜在原因清单',
      headers: ['类别', '序号', '潜在原因'],
      rows: data.categories.flatMap((category) => category.causes.length
        ? category.causes.map((cause, index) => [category.name, index + 1, cause])
        : [[category.name, '—', '尚未录入']]),
    }],
    charts: [svgChart(`6M 因果图 · ${data.problem}`, <FishboneChart T={T} data={data} />, 960, 430)],
  };
}

function buildCapabilityPayload(): AnalysisReportPayload {
  const app = useApp.getState();
  const data = useData.getState();
  const prepared = resolveCapabilityMeasurementData(data.model, data.textCols);
  if (prepared.error || !prepared.model) {
    return unrunPayload('capability', '过程能力分析专项报告', data.model.name, prepared.error ?? '当前测量数据角色无效。', true);
  }
  const M = prepared.model;
  const spec = {
    lsl: app.lslOn ? app.lsl : null,
    tgt: app.tgt,
    usl: app.uslOn ? app.usl : null,
  };
  const specWarning = capabilitySpecDistanceWarning(M.all, M.sigmaWithin, spec);
  const warningFingerprint = capabilityWarningFingerprint(
    capabilitySpecKey(data.model, data.textCols) ?? `${data.model.name}:${prepared.variableName}`,
    M.all,
    M.sigmaWithin,
    spec,
    capabilitySubgroupSemantics(data.model, data.textCols) ?? '',
  );
  const warningAcknowledged = specWarning != null && warningFingerprint != null
    && app.capabilityWarningAcknowledgement === warningFingerprint;
  const inputError = capabilityInputError(M.all, M.sigmaWithin, spec, { allowDistantSpec: warningAcknowledged });
  if (inputError) return unrunPayload('capability', '过程能力分析专项报告', data.model.name, inputError, true);
  const cap = computeCapability(M.all, M.sigmaWithin, spec, { allowDistantSpec: warningAcknowledged });
  const ad = M.all.length >= 8 ? andersonDarling(M.all) : null;
  // P0-4:与能力页/保存记录共用唯一判定器,失控时专项报告不得写「能力充足」而无警告。
  const capabilitySpcModel = withSigmaMethod(M, app.spcSigmaMethod);
  const capabilityFamily = spcChartFamilyFor(capabilitySpcModel, app.spcType);
  const assessment = assessCapability({
    cpk: cap.cpk, verdict: cap.verdict, adP: ad ? ad.p : null, n: M.all.length,
    spcViolations: countCapabilityViolations(capabilitySpcModel, app.spcRules, app.spcRuleK, capabilityFamily),
  });
  // CORE-09/UI-12:能力稳定性有意不分阶段、按子组图评估;与 SPC 页视图不同时报告必须写明口径。
  // fix2609k G20:视图/阶段取 SPC 页实际生效口径(与能力页/看板/保存记录/Modals 同源)。
  const { spcViewType, spcStage } = spcStabilityViewFromRoles(data.model, data.textCols, {
    layout: app.spcDataLayout, valueColumn: app.spcValueCol, subgroupColumn: app.spcSubgroupCol,
    pendingCells: data.pendingCells,
  }, app.spcType, app.spcStageCol);
  const stabilityCaliber = capabilityStabilityCaliber({ capabilityFamily, spcViewType, spcStage });
  const verdict = assessment.status;
  const capabilitySourceRowCount = Math.min(
    M.hasSubgroups ? M.subs.length : M.indiv.length,
    MAX_SPC_REPORT_DETAIL_ROWS,
  );
  // fix2609k:原始观测整表全精度(定点可无损时与既有报告逐字相同)
  const capabilityRaw = rawFmt(M.hasSubgroups
    ? groupValues(M.subs.slice(0, capabilitySourceRowCount))
    : M.indiv.slice(0, capabilitySourceRowCount));
  const sourceTable = M.hasSubgroups
    ? {
        title: '用于能力分析的解析子组数据',
        headers: ['子组', ...M.colNames],
        rows: M.subs.slice(0, capabilitySourceRowCount).map((subgroup, index) => [prepared.subgroupLabels[index] ?? subgroup.i, ...subgroup.vals.map((value) => capabilityRaw(value))]),
        totalRows: M.subs.length,
        note: boundedReportTableNote(prepared.note, M.subs.length, capabilitySourceRowCount),
      }
    : {
        title: '用于能力分析的解析单值数据',
        headers: ['观测', prepared.variableName],
        rows: M.indiv.slice(0, capabilitySourceRowCount).map((value, index) => [prepared.subgroupLabels[index] ?? index + 1, capabilityRaw(value)]),
        totalRows: M.indiv.length,
        note: boundedReportTableNote(prepared.note, M.indiv.length, capabilitySourceRowCount),
      };
  return {
    kind: 'capability',
    usesWorksheet: true,
    title: '过程能力分析专项报告',
    subtitle: `${prepared.variableName} · ${prepared.layoutLabel} · N=${M.all.length}`,
    generatedAt: now(),
    summary: [
      `Cpk=${fmt(cap.cpk, 4)}，Ppk=${fmt(cap.ppk, 4)}，${verdict}。${assessment.spcViolations > 0 ? assessment.headline : ''}`,
      `规格：${reportSpecDetailText({ lsl: app.lslOn ? app.lsl : null, tgt: app.tgt, usl: app.uslOn ? app.usl : null })}；${prepared.note}。`,
      ad ? `Anderson-Darling A²*=${fmt(ad.a2star, 4)}，P=${fmt(ad.p, 6)}，${ad.normal ? '未拒绝正态性' : '显著偏离正态分布'}。` : '样本量不足 8，未执行 Anderson-Darling 正态性检验。',
    ],
    warnings: [
      assessment.spcViolations > 0 ? `控制图检出 ${assessment.spcViolations} 个失控点——过程不稳定，能力指标只描述当前样本，不能预测未来质量。` : '',
      stabilityCaliber ? `稳定性口径：${stabilityCaliber.text}。` : '',
      specWarning && warningAcknowledged ? `用户已对当前测量角色与 LSL/Target/USL 显式确认继续；${specWarning.message}，能力指标必须连同本警告解读。` : '',
      !app.lslOn || !app.uslOn ? '当前为单侧规格，Cp/Pp 不适用；Cpm 按启用侧距离 (Minitab 单侧式) 计算；Cpk 退化为启用一侧的 CPU 或 CPL。' : '',
      ad && !ad.normal ? '数据显著偏离正态，正态分布能力指标需谨慎解释，并考虑 Box-Cox 或非正态能力方法。' : '',
    ].filter(Boolean),
    tables: [
      sourceTable,
      {
        title: '能力与性能指标',
        headers: ['N', '均值', 'σ组内', 'σ整体', 'Cp', 'Cpk', 'CPU', 'CPL', 'Pp', 'Ppk', 'Cpm', 'Z.bench', 'σ水平'],
        rows: [[
          cap.n, fmt(cap.mean), fmt(cap.sigmaWithin), fmt(cap.sigmaOverall), fmt(cap.cp), fmt(cap.cpk), fmt(cap.cpu), fmt(cap.cpl),
          fmt(cap.pp), fmt(cap.ppk), fmt(cap.cpm), fmt(cap.zBench), fmt(cap.sigmaLevel),
        ]],
      },
      {
        title: '每百万缺陷数（PPM）',
        headers: ['口径', '低于 LSL', '高于 USL', '合计'],
        rows: [
          ['实测', '—', '—', Math.round(cap.ppm.observed)],
          ['组内（潜在）', cap.ppm.within.belowLsl == null ? '—' : Math.round(cap.ppm.within.belowLsl), cap.ppm.within.aboveUsl == null ? '—' : Math.round(cap.ppm.within.aboveUsl), Math.round(cap.ppm.within.total)],
          ['整体（实际）', cap.ppm.overall.belowLsl == null ? '—' : Math.round(cap.ppm.overall.belowLsl), cap.ppm.overall.aboveUsl == null ? '—' : Math.round(cap.ppm.overall.aboveUsl), Math.round(cap.ppm.overall.total)],
        ],
      },
    ],
    charts: [
      svgChart('过程能力直方图', <Histogram T={T} data={M.all} mu={M.oMean} sigmaWithin={M.sigmaWithin} sigmaOverall={M.oSd} lsl={app.lslOn ? app.lsl : null} usl={app.uslOn ? app.usl : null} tgt={app.tgt} h={320} bins={app.capabilityBins} />, 960, 320),
      svgChart('正态概率图', <NormalProbPlot T={T} data={M.all} h={300} />, 960, 300),
    ],
  };
}

function buildGagePayload(): AnalysisReportPayload {
  const app = useApp.getState();
  const data = useData.getState();
  const requestedReal = !data.model.isDemo && app.gageUseReal;
  // 与 MSA 页同源(716-R3):未手选角色用推荐补齐;锚定角色供批量表复用(审查修复:逐行不得各自按位置默认解析)
  const effSel = effectiveGageSelection(data.model, data.textCols,
    { value: app.gageValueName, part: app.gagePartName, operator: app.gageOperatorName });
  const prepared = prepareGageStudy(data.model, data.textCols, { ...effSel, pendingCells: data.pendingCells });
  // 批次720-B:批量 GRR 逐响应明细表——列过滤与页面同源(剔除生效部件/操作员列),
  // 且在主研究失败时仍随「尚未运行」报告输出(页面失败态也显示批量卡,两端必须对称)。
  const gageBatchTable = (() => {
    if (!requestedReal) return null;
    // 锚定角色与页面同规则:effective 为 null 时用主研究解析出的实际列(避免逐行位置默认漂移)
    const anchorPart = effSel.partColumn ?? (prepared.ok ? prepared.study.partName : null);
    const anchorOperator = effSel.operatorColumn ?? (prepared.ok ? (prepared.study.operatorName ?? GAGE_SINGLE_OPERATOR) : null);
    const selected = (normalizeGageBatchCols(app.gageBatchCols) ?? []).filter((name) =>
      data.model.colNames.includes(name) && name !== anchorPart && name !== anchorOperator);
    if (selected.length < 2) return null;
    // 报告是审计记录：用户选中的响应必须全部逐列列出，不做 UI 预览数量截断。
    const rows = selected.map((col) => {
      const prepCol = prepareGageStudy(data.model, data.textCols, {
        valueColumn: col, partColumn: anchorPart, operatorColumn: anchorOperator, pendingCells: data.pendingCells,
      });
      if (!prepCol.ok) return [col, '—', '—', '—', '—', '—', '—', '—', '—', `未计算：${prepCol.reason}`];
      const mem = col === effSel.valueColumn
        ? { mode: app.gageTolMode, value: app.gageTolValue }
        : app.gageTolByCol[col] ?? { mode: 'none' as const, value: null };
      const spec = resolveGageTolerance({ gageTolMode: mem.mode, gageTolValue: mem.value, lsl: app.lsl, usl: app.usl, lslOn: app.lslOn, uslOn: app.uslOn });
      try {
        const r = computeGageRR(prepCol.study.observations, spec);
        const grrRow = r.components.find((component) => component.key === 'grr');
        const factoryVerdict = assessGage(r, 'factory');
        const aiagVerdict = assessGage(r, 'aiag');
        return [
          col,
          fmt(grrRow?.variance, 8),
          fmt(grrRow?.sd, 6),
          fmt(grrRow?.studyVar, 6),
          fmt(grrRow?.pctStudyVar ?? r.totalGageRR, 2),
          grrRow?.pctTolerance == null ? (r.tolerance == null ? '未设' : '未计算') : fmt(grrRow.pctTolerance, 2),
          r.ndc === Infinity ? '∞' : String(r.ndc),
          factoryVerdict.label,
          aiagVerdict.label,
          '已计算',
        ];
      } catch (error) {
        return [col, '—', '—', '—', '—', '—', '—', '—', '—', `未计算：${(error as Error).message}`];
      }
    });
    return {
      title: `批量 GRR 逐响应明细 · ${selected.length} 个测量列(逐列独立计算)`,
      headers: ['测量列', 'GRR 方差分量', 'GRR 标准差(SD)', '研究变异(6×SD)', '%研究变异', '%公差', 'ndc', '工厂判定', 'AIAG 对照', '计算状态'],
      rows,
      note: '每个测量列都使用同一对部件/操作员角色独立重新计算；不合并响应、不共用方差。单列失败只在该行标记“未计算”，不会阻断其他列。图形报告仅对应当前测量响应，其余已选响应以本明细表为准。',
    };
  })();
  if (requestedReal && !prepared.ok) {
    return {
      ...unrunPayload('gagerr', '测量系统分析 Gage R&R 专项报告', data.model.name, prepared.reason, true),
      tables: gageBatchTable ? [gageBatchTable] : [],
    };
  }
  const observations = requestedReal && prepared.ok ? prepared.study.observations : gageStudyData();
  const gageObservationRows = Math.min(observations.length, MAX_SPC_REPORT_DETAIL_ROWS);
  const gageRaw = rawFmt(observations.slice(0, gageObservationRows).map((observation) => observation.value));
  const tolerance = requestedReal
    ? resolveGageTolerance(app)
    : { mode: 'width' as const, value: GAGE_TOLERANCE };
  let result: ReturnType<typeof computeGageRR>;
  try {
    result = computeGageRR(observations, tolerance);
  } catch (error) {
    return {
      ...unrunPayload('gagerr', '测量系统分析 Gage R&R 专项报告', data.model.name, (error as Error).message, requestedReal),
      tables: gageBatchTable ? [gageBatchTable] : [],
    };
  }
  const realStudy = requestedReal && prepared.ok ? prepared.study : null;
  const primary = assessGage(result, app.gageStandard);
  const reference = assessGage(result, app.gageStandard === 'factory' ? 'aiag' : 'factory');
  const single = result.operatorCount === 1;
  const operatorRowLabel = realStudy?.operatorName ?? '操作员';
  const panelData = computeGagePanelData(observations, CONTROL_CONSTANTS[result.trialCount] ?? null);
  const partLabels = realStudy?.partLabels ?? Array.from({ length: panelData.partCount }, (_, index) => String(index + 1));
  const operatorLabels = realStudy?.operatorLabels ?? ['A', 'B', 'C'];
  const cats = gageBarCategories(result);
  const generatedAt = now();
  const infoOrMissing = (value: string) => value.trim() || '未填写';
  const figureProps = {
    T, panel: panelData, partLabels, operatorLabels, cats,
    valueName: realStudy?.valueName ?? '演示测量',
    partName: realStudy?.partName ?? '部件',
    operatorName: realStudy ? (realStudy.operatorName ?? '测试人') : '测试人',
    gaugeName: infoOrMissing(app.gageGaugeName),
    reportBy: infoOrMissing(app.gageReportBy),
    studyDate: app.gageStudyDate || '未填写',
    otherText: infoOrMissing(app.gageNotes),
    toleranceText: tolerance == null ? '未设置' : tolerance.mode === 'width' ? String(tolerance.value) : `${tolerance.mode === 'upper' ? '上限' : '下限'} ${tolerance.value}`,
  } as const;
  return {
    kind: 'gagerr',
    usesWorksheet: requestedReal,
    title: '测量系统分析 Gage R&R 专项报告',
    subtitle: requestedReal && realStudy
      ? `${realStudy.valueName} · 部件 ${realStudy.partName} · 操作员 ${realStudy.operatorName ?? '单操作员'} · ${realStudy.partLabels.length}×${realStudy.operatorLabels.length}×${realStudy.repeats}`
      : '内置 10 部件 × 3 操作员 × 2 重复演示研究 · 非用户数据',
    generatedAt,
    summary: [
      `合计 Gage R&R=${fmt(result.totalGageRR, 3)}%（研究变异），${primary.standard === 'factory' ? '工厂标准' : 'AIAG'}判定：${primary.label}。${primary.detail}`,
      `对照口径（${reference.standard === 'factory' ? '工厂标准' : 'AIAG'}）：${reference.label}。`,
      `可区分的类别数 ndc = ${result.ndc === Infinity ? '∞' : result.ndc}（AIAG 建议 ≥5）。`,
      result.interaction
        ? `部件×操作员交互项 p=${fmt(result.interaction.pValue, 4)}（α=${fmt(result.interaction.alpha, 2)}），${result.interaction.retained ? '显著，最终模型保留交互分量' : '不显著，已将交互 SS/df 合并到重复性误差'}。`
        : '单操作员研究：按单因子随机效应模型计算，合计量具 R&R = 重复性，不估计再现性。',
    ],
    warnings: [
      ...(!requestedReal ? ['本报告使用内置交叉 Gage R&R 演示研究，不得当作用户测量系统结论。'] : []),
      ...(requestedReal && tolerance == null ? ['未提供过程公差（可在 MSA 页设置双侧宽度或单侧限）；% 公差不可计算，报表以“—”显示。'] : []),
      ...(result.toleranceNote ? [result.toleranceNote] : []),
    ],
    tables: [
      ...(gageBatchTable ? [gageBatchTable] : []),
      {
        title: '量具研究信息',
        headers: ['量具名称', '报表人', '研究日期', '报告生成时间', '其他备注'],
        rows: [[
          infoOrMissing(app.gageGaugeName),
          infoOrMissing(app.gageReportBy),
          app.gageStudyDate || '未填写',
          generatedAt,
          infoOrMissing(app.gageNotes),
        ]],
        note: '量具名称、报表人、研究日期与备注均为用户手工填写；系统不从操作员标签或导出时间推断。图形表头过长时仅缩略显示，完整值以本表为准。',
      },
      {
        title: requestedReal
          ? single ? '导入的单操作员研究原始观测' : '导入的交叉研究原始观测'
          : '演示交叉研究原始观测',
        headers: ['部件', '操作员', '重复', realStudy?.valueName ?? '测量值'],
        rows: observations.slice(0, gageObservationRows).map((observation) => [
          realStudy?.partLabels[observation.part] ?? observation.part + 1,
          realStudy?.operatorLabels[observation.operator] ?? observation.operator + 1,
          observation.trial + 1,
          gageRaw(observation.value),
        ]),
        totalRows: observations.length,
      },
      {
        title: '方差分量与研究变异',
        headers: ['来源', '标准差(SD)', '研究变异(6×SD)', '方差分量', '%贡献', '%研究变异', '%公差(SV/Toler)'],
        rows: result.components.map((component) => [
          component.key === 'operator' ? `    ${operatorRowLabel}` : component.source,
          fmt(component.sd, 6), fmt(component.studyVar, 6),
          fmt(component.variance, 8), fmt(component.pctContribution), fmt(component.pctStudyVar), fmt(component.pctTolerance),
        ]),
        // 备注必须写实际使用的判定标准,不能固定 AIAG(Codex 复审 P1)
        note: (tolerance == null
          ? '未提供过程公差，% 公差不可计算；研究变异与判定不受影响。'
          : tolerance.mode === 'width'
            ? `过程公差宽度=${fmt(tolerance.value, 8)}。`
            : `过程公差${tolerance.mode === 'upper' ? '上限' : '下限'}=${fmt(tolerance.value, 8)}（单侧：%公差=3×SD/|限值−总均值|，总均值=${fmt(result.grandMean, 6)}，实际公差距离=${fmt(Math.abs(tolerance.value - result.grandMean), 6)}）。`)
          + (app.gageStandard === 'factory'
            ? '判定阈值按工厂标准：主要(%研究变异)与次要(%公差)均 ≤10% 理想、≤20% 可接受，取两项较差。'
            : '判定阈值按 AIAG：<10% 可接受 / 10–30% 临界 / >30% 不可接受。'),
      },
    ],
    // 图形报告:与工厂 Minitab 17 图窗同布局的单张整图(单操作员 4 联/多操作员 6 联)
    charts: [
      svgChart(
        `量具 R&R(ANOVA) 图形报告（${single ? '4 联' : '6 联'}）`,
        <GageReportFigure {...figureProps} />,
        1160,
        single ? 690 : 1030,
        gageBatchTable
          ? `本图仅对应当前测量响应“${realStudy?.valueName ?? '演示测量'}”；其他已选响应的独立结果见“批量 GRR 逐响应明细”。`
          : undefined,
      ),
    ],
  };
}

function buildSpcPayload(): AnalysisReportPayload | undefined {
  const app = useApp.getState();
  const data = useData.getState();
  if (app.spcType === 'p' || app.spcType === 'c') {
    const isP = app.spcType === 'p';
    const values = isP ? data.pModel.pprop : data.cModel.cdata;
    const cl = isP ? data.pModel.pbar : data.cModel.cbar;
    const ucl = isP ? data.pModel.pUcl : data.cModel.cUcl;
    const lcl = isP ? data.pModel.pLcl : data.cModel.cLcl;
    const evaluated = evalLimitedRules(
      values,
      cl,
      isP ? data.pModel.pUcls : ucl,
      isP ? data.pModel.pLcls : lcl,
      app.spcRules,
      app.spcRuleK,
      // P/C 图控制限有钳位,判异用真实 σ(与 SPC 页同口径)
      isP ? data.pModel.pNs.map((n) => Math.sqrt(cl * (1 - cl) / n)) : Math.sqrt(cl),
      SPC_REPORT_RULE_OPTIONS,
    );
    const typeLabel = isP ? 'P' : 'C';
    const items = reportRuleItems(evaluated, typeLabel);
    const violationSummary = combineRuleSummaries([{ evaluation: evaluated }]);
    const modelName = isP ? data.pModel.name : data.cModel.name;
    const sampleSize = isP ? data.pModel.pNs : 1;
    const sourceRowCount = Math.min(values.length, MAX_SPC_REPORT_DETAIL_ROWS);
    const report = spcReport({
      violList: items, violationSummary, k: values.length, n: sampleSize, hasSubgroups: false,
      structure: isP ? 'attribute-p' : 'attribute-c', typeLabel,
      variableName: isP ? '不良率' : '单位缺陷数', dataRole: isP ? '不合格品数 / 每批检验数' : '每单位缺陷数',
    });
    return {
      kind: 'spc', title: `${typeLabel} 控制图专项报告`, subtitle: `${modelName} · ${values.length} 个点`, generatedAt: now(),
      summary: [report.headline], warnings: [],
      tables: [
        {
          title: `用于 ${typeLabel} 控制图的原始计数数据`,
          headers: isP ? ['样本', '不合格品数', '检验数', '不良率', 'LCL', 'UCL'] : ['单位', '缺陷数'],
          rows: values.slice(0, sourceRowCount).map((value, index) => isP
            ? [
                index + 1, data.pModel.pdef[index], data.pModel.pNs[index], fmt(value, 8),
                fmt(data.pModel.pLcls[index], 8), fmt(data.pModel.pUcls[index], 8),
              ]
            : [index + 1, data.cModel.cdata[index]]),
          totalRows: values.length,
          note: boundedReportTableNote(isP
            ? `不良率 = 不合格品数 / 每批检验数；p̄ 按总不良数 / 总检验数计算，LCL/UCL 按每批 nᵢ 计算并截断到 [0,1]。${data.pModel.pVariableN ? '本数据使用逐批变化的样本量。' : ''}`
            : '每个点为一个相同机会区域/单位的缺陷数。', values.length, sourceRowCount),
        },
        {
          title: '控制限', headers: ['图', 'CL', 'UCL', 'LCL', '异常点数'],
          rows: [[
            typeLabel,
            fmt(cl),
            isP && data.pModel.pVariableN ? '逐批见原始计数表' : fmt(ucl),
            isP && data.pModel.pVariableN ? '逐批见原始计数表' : fmt(lcl),
            evaluated.viol.size,
          ]],
        },
        {
          title: '判异明细',
          headers: ['点', '准则', '说明'],
          rows: items.map((item) => [item.i + 1, item.rule, item.desc]),
          totalRows: violationSummary.pointRuleHitCount,
          note: spcDetailNote(violationSummary, items.length, '属性图按适用性执行 Nelson/Minitab 准则 1–4。'),
        },
      ],
      charts: [svgChart(`${typeLabel} 控制图 · ${modelName}`, <ControlChart
        T={T} data={values} cl={cl} ucl={ucl} lcl={lcl} clLabel={isP ? 'p̄' : 'c̄'}
        zones={app.spcShowZones && (!isP || !data.pModel.pVariableN)}
        uclSeries={isP && data.pModel.pVariableN ? data.pModel.pUcls : undefined}
        lclSeries={isP && data.pModel.pVariableN ? data.pModel.pLcls : undefined}
        h={300} violations={evaluated.viol} xLabel={isP ? '样本序号' : '单位序号'} yLabel={isP ? '样本不良率' : '单位缺陷数'}
      />, 960, 300)],
    };
  }

  const prepared = prepareSpcData(data.model, data.textCols, {
    layout: app.spcDataLayout,
    valueColumn: app.spcValueCol,
    subgroupColumn: app.spcSubgroupCol,
    pendingCells: data.pendingCells,
  });
  if (prepared.error || !prepared.model) {
    return {
      kind: 'spc', title: `${app.spcType.toUpperCase()} 控制图专项报告`, subtitle: data.model.name, generatedAt: now(),
      summary: ['控制图未运行，未生成统计结论。'], warnings: [prepared.error ?? '当前数据角色配置无效。'], tables: [], charts: [],
    };
  }
  const M = withSigmaMethod(prepared.model, app.spcSigmaMethod);
  const rCenterLabel = app.spcSigmaMethod === 'classic' ? 'R̄' : 'd₂σ̂';
  const sCenterLabel = app.spcSigmaMethod === 'classic' ? 'S̄' : 'c₄σ̂';
  // 审查修复(720-A3):报告图表标签位数与页面同一派生规则(均值类=数据位数+1,极差类=数据位数)
  const dataDp = dataDecimals(M.hasSubgroups ? M.all : M.indiv);
  const meanDec = Math.min(dataDp + 1, 4);
  const rangeDec = Math.min(dataDp, 4);
  // 与 SPC 页面保持一致：自动布局只解析到单值时，X̄-R / X̄-S
  // 没有合法子组统计量，必须明确按 I-MR 分析，不能导出“未运行”或伪子组。
  const effectiveType = !M.hasSubgroups && (app.spcType === 'xbar-r' || app.spcType === 'xbar-s')
    ? 'i-mr'
    : app.spcType;
  const means = M.subs.map((sub) => sub.mean);
  const labelsFor = (length: number) => prepared.subgroupLabels.length === length ? prepared.subgroupLabels : undefined;
  const stageValues = app.spcStageCol
    ? prepared.textCols.find((column) => column.name === app.spcStageCol)?.values
    : undefined;
  const sourceLabels = labelsFor(M.k);
  const sourceRowCount = Math.min(M.hasSubgroups ? M.k : M.indiv.length, MAX_SPC_REPORT_DETAIL_ROWS);
  const spcRaw = rawFmt(M.hasSubgroups ? groupValues(M.subs.slice(0, sourceRowCount)) : M.indiv.slice(0, sourceRowCount));
  const spcSourceTable = M.hasSubgroups
    ? {
        title: '用于控制图的解析子组数据',
        headers: ['子组', ...(stageValues?.length === M.k ? ['阶段'] : []), ...M.colNames],
        rows: M.subs.slice(0, sourceRowCount).map((sub, index) => [
          sourceLabels?.[index] ?? sub.i,
          ...(stageValues?.length === M.k ? [stageValues[index]] : []),
          ...sub.vals.map((value) => spcRaw(value)),
        ]),
        totalRows: M.k,
        note: boundedReportTableNote(prepared.note, M.k, sourceRowCount),
      }
    : {
        title: '用于控制图的解析单值数据',
        headers: ['观测', prepared.variableName],
        rows: M.indiv.slice(0, sourceRowCount).map((value, index) => [labelsFor(M.indiv.length)?.[index] ?? index + 1, spcRaw(value)]),
        totalRows: M.indiv.length,
        note: boundedReportTableNote(prepared.note, M.indiv.length, sourceRowCount),
      };

  // CORE-08:Shewhart σ̂ 守卫(与 SPC 页/看板/保存记录/通用导出同源)。控制限塌缩时不判异、不出图
  // (亚 ulp 纵轴无判读意义),UCL/LCL 只写「不可判定」,不把中心线冒充控制限。
  const shewhartUnavailablePayload = (family: SpcChartFamily, pointCount: number, unitLabel: string): AnalysisReportPayload | null => {
    const reason = shewhartSigmaIssue(M, family);
    if (!reason) return null;
    const typeLabel = family === 'i-mr' ? 'I-MR' : family === 'xbar-s' ? 'X̄-S' : 'X̄-R';
    const cl = family === 'i-mr' ? M.indMean : M.xbarbar;
    return {
      kind: 'spc', title: `${typeLabel} 控制图专项报告 · 不可判定`,
      subtitle: `${prepared.variableName} · ${prepared.layoutLabel} · ${pointCount} 个${unitLabel}`, generatedAt: now(),
      summary: [
        `${typeLabel} 不可判定：${reason}。`,
        '控制限塌缩为一条线，任何舍入误差都会被误判为超限，未执行判异；请先核查量具分辨率（读数是否全部相同）或补测有效变异。',
        prepared.note,
      ],
      warnings: [reason],
      tables: [
        spcSourceTable,
        {
          title: '控制限', headers: ['图', 'CL', 'UCL', 'LCL', '异常点数'],
          rows: [[family === 'i-mr' ? 'I' : 'X̄', fmt(cl), '—（不可判定）', '—（不可判定）', '—']],
          note: `σ̂ 不可判定：${reason}。`,
        },
      ],
      charts: [],
    };
  };

  if (effectiveType === 'i-mr') {
    const unavailable = shewhartUnavailablePayload('i-mr', M.indiv.length, '观测');
    if (unavailable) return unavailable;
    const iEval = evalRules(
      M.indiv, M.indMean, (M.iUcl - M.indMean) / 3,
      app.spcRules, app.spcRuleK, SPC_REPORT_RULE_OPTIONS,
    );
    const mr = M.mr.slice(1) as number[];
    const mrEval = evalLimitedRules(
      mr, M.mrbar, M.mrUcl, 0,
      app.spcRules, app.spcRuleK, undefined, SPC_REPORT_RULE_OPTIONS,
    );
    const iItems = reportRuleItems(iEval, 'I');
    const mrItems = reportRuleItems(mrEval, 'MR', 1);
    const violationSummary = combineRuleSummaries([
      { evaluation: iEval },
      { evaluation: mrEval, indexOffset: 1 },
    ]);
    const variationSummary = combineRuleSummaries([{ evaluation: mrEval, indexOffset: 1 }]);
    const allItems = [...iItems, ...mrItems]
      .sort((a, b) => a.i - b.i || a.rule - b.rule)
      .slice(0, MAX_SPC_REPORT_DETAIL_ROWS);
    const report = spcReport({
      violList: allItems, violationSummary,
      variationViolations: mrItems, variationSummary, variationChartLabel: 'MR',
      k: M.indiv.length, n: 1, hasSubgroups: false, structure: 'individual', typeLabel: 'I-MR',
      variableName: prepared.variableName, dataRole: prepared.note,
    });
    const labels = labelsFor(M.indiv.length);
    return {
      kind: 'spc', title: 'I-MR 控制图专项报告', subtitle: `${prepared.variableName} · ${prepared.layoutLabel} · ${M.indiv.length} 个观测`, generatedAt: now(),
      summary: [report.headline, `判读顺序：${report.details.readingOrder}。`, prepared.note],
      warnings: mrEval.viol.size ? ['MR 图存在特殊原因信号，先调查相邻观测变异，再解释 I 图。'] : [],
      tables: [
        spcSourceTable,
        { title: '控制限', headers: ['图', 'CL', 'UCL', 'LCL', '异常点数'], rows: [['I', fmt(M.indMean), fmt(M.iUcl), fmt(M.iLcl), iEval.viol.size], ['MR', fmt(M.mrbar), fmt(M.mrUcl), '0', mrEval.viol.size]] },
        {
          title: '判异明细', headers: ['观测', '子图', '准则', '说明'],
          rows: allItems.map((item) => [labels?.[item.i] ?? item.i + 1, item.chartLabel, item.rule, item.desc]),
          totalRows: violationSummary.pointRuleHitCount,
          note: spcDetailNote(violationSummary, allItems.length),
        },
      ],
      charts: [
        svgChart(`${prepared.variableName} 的单值控制图 (I)`, <ControlChart T={T} data={M.indiv} cl={M.indMean} ucl={M.iUcl} lcl={M.iLcl} clLabel="X̄" zones={app.spcShowZones} dec={meanDec} h={250} violations={iEval.viol} xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 单值`} xLabels={labels} />, 960, 250),
        svgChart(`${prepared.variableName} 的移动极差图 (MR)`, <ControlChart T={T} data={mr} cl={M.mrbar} ucl={M.mrUcl} lcl={0} clLabel="MR̄" zones={app.spcShowZones} dec={rangeDec} h={210} violations={mrEval.viol} xIndexOffset={1} xLabel="观测序号（MR 从第 2 个观测开始）" yLabel={`${prepared.variableName} · 移动极差`} xLabels={labels?.slice(1)} />, 960, 210),
      ],
    };
  }

  if (effectiveType === 'ewma' || effectiveType === 'cusum') {
    const source = M.hasSubgroups ? means : M.indiv;
    const mu = M.hasSubgroups ? M.xbarbar : M.indMean;
    const sigma = M.hasSubgroups ? withSigmaMethod(M, app.spcSigmaMethod).sigmaChart / Math.sqrt(M.n) : M.iSig;
    const isEwma = effectiveType === 'ewma';
    const ewma = isEwma ? ewmaSeries(source, mu, sigma) : null;
    const hValue = cusumH(M.hasSubgroups);
    const cusum = isEwma ? null : cusumSeries(source, mu, sigma, CUSUM_K, hValue);
    const viol = ewma?.viol ?? cusum!.viol;
    const values = ewma?.z ?? cusum!.cp;
    const typeLabel = isEwma ? 'EWMA' : 'CUSUM';
    // S-1:常数与页面图注共用同一格式化函数(advancedSpcParams),且取自本次计算实际所用值。
    const paramsText = ewma ? ewmaParamsText(ewma.lambda, ewma.L) : cusumParamsText(CUSUM_K, hValue);
    const sigmaNote = M.hasSubgroups
      ? `子组均值序列的 σ̂/√n(σ̂ 取 ${app.spcSigmaMethod === 'pooled' ? '合并标准差' : 'R̄/d₂'})`
      : '单值序列的 σ̂(MR̄/d₂)';
    // CORE-08:σ̂=0/非有限/亚分辨率时不可判定,与页面/保存记录同一原因,不写「超限/小漂移」或「未检出」。
    const unavailableReason = ewma ? ewma.unavailableReason : cusum!.unavailableReason;
    // 不可判定时 UCL/LCL(塌缩到 μ₀)与 H/K(记 0)只是占位,不得当作真实参数写进可复算的常数表;
    // λ/L/k/h 设计常数本身仍有效,照常披露。
    const UNDETERMINED = '—（不可判定）';
    const sigmaText = Number.isFinite(sigma) ? fmt(sigma, 8) : '—（非有限）';
    const paramRows: (string | number)[][] = ewma
      ? [
          ['中心线 μ₀', fmt(mu, 8), M.hasSubgroups ? '子组均值的总均值 X̿' : '单值均值 X̄'],
          ['σ(每点)', sigmaText, sigmaNote],
          ['权重 λ', ewma.lambda, 'z_i = λx_i + (1−λ)z_{i−1},z_0 = μ₀'],
          ['控制限宽度 L', ewma.L, `时变控制限 μ₀ ± L·σ·√(λ/(2−λ)·(1−(1−λ)^{2i}));Minitab 默认 L=${MINITAB_DEFAULT_EWMA_L}`],
          ['UCL(末端)', unavailableReason ? UNDETERMINED : fmt(ewma.ucl[ewma.ucl.length - 1], 8), ''],
          ['LCL(末端)', unavailableReason ? UNDETERMINED : fmt(ewma.lcl[ewma.lcl.length - 1], 8), ''],
        ]
      : [
          ['目标 μ₀', fmt(mu, 8), M.hasSubgroups ? '子组均值的总均值 X̿' : '单值均值 X̄'],
          ['σ(每点)', sigmaText, sigmaNote],
          ['允差系数 k', CUSUM_K, `K = k·σ = ${unavailableReason ? UNDETERMINED : fmt(cusum!.K, 8)}`],
          ['判定限系数 h', hValue, `H = h·σ = ${unavailableReason ? UNDETERMINED : fmt(cusum!.H, 8)};Minitab 默认 h=${MINITAB_DEFAULT_CUSUM_H}`],
        ];
    return {
      kind: 'spc', title: `${typeLabel} 控制图专项报告`, subtitle: `${prepared.variableName} · ${source.length} 个点`, generatedAt: now(),
      summary: [
        unavailableReason
          ? `${typeLabel} 不可判定：${unavailableReason}。`
          : viol.size ? `${typeLabel} 检出 ${viol.size} 个超限点，存在小漂移/累积偏移信号。` : `${typeLabel} 未检出超限点。`,
        `${typeLabel} 设计常数：${paramsText}。`,
        prepared.note,
      ],
      warnings: unavailableReason ? [unavailableReason] : [],
      tables: [spcSourceTable, {
        title: `${typeLabel} 设计常数`,
        headers: ['参数', '值', '说明'],
        rows: paramRows,
        note: unavailableReason
          ? `${paramsText}。σ̂ 不可判定，控制限未计算：${unavailableReason}。`
          : `${paramsText}。按本表常数与源数据可逐点复算。`,
      }, {
        title: '超限点',
        headers: ['点', '说明'],
        rows: boundedViolationRows(viol, source.length, isEwma ? 'EWMA 超出时变控制限' : 'CUSUM 超出判定限 H'),
        totalRows: viol.size,
      }],
      // σ̂=0 时控制限塌缩到中心线，图形没有判读意义(且亚 ulp 纵轴跨度会让刻度生成失控)，不出图。
      charts: unavailableReason ? [] : [svgChart(
        `${prepared.variableName} 的 ${typeLabel} 控制图`,
        <ControlChart
          T={T} data={values} series2={cusum?.cn} series2Label={cusum ? 'C⁻' : undefined}
          cl={ewma?.cl ?? 0} ucl={ewma ? ewma.ucl[ewma.ucl.length - 1] : cusum!.H} lcl={ewma ? ewma.lcl[ewma.lcl.length - 1] : 0}
          clLabel={ewma ? 'μ₀' : '0'} h={300} violations={viol}
          uclSeries={ewma?.ucl} lclSeries={ewma?.lcl} xLabel={M.hasSubgroups ? prepared.xAxisLabel : '观测序号'} yLabel={`${prepared.variableName} · ${typeLabel}`} xLabels={labelsFor(source.length)}
        />,
        960,
        300,
      )],
    };
  }

  if (!M.hasSubgroups) {
    return {
      kind: 'spc', title: `${app.spcType.toUpperCase()} 控制图专项报告`, subtitle: prepared.variableName, generatedAt: now(),
      summary: ['当前数据没有 2–10 个观测组成的等大小子组，所选子组控制图未运行。'], warnings: ['请选择正确的数据布局/角色，或改用 I-MR。'], tables: [], charts: [],
    };
  }

  if (effectiveType === 'xbar-s') {
    const unavailable = shewhartUnavailablePayload('xbar-s', M.k, '子组');
    if (unavailable) return unavailable;
    const xEval = evalRules(
      means, M.xbarbar, (M.uclXs - M.xbarbar) / 3,
      app.spcRules, app.spcRuleK, SPC_REPORT_RULE_OPTIONS,
    );
    const sEval = evalLimitedRules(
      M.svals, M.sCl, M.uclS, M.lclS,
      app.spcRules, app.spcRuleK, undefined, SPC_REPORT_RULE_OPTIONS,
    );
    const xItems = reportRuleItems(xEval, 'X̄');
    const sItems = reportRuleItems(sEval, 'S');
    const violationSummary = combineRuleSummaries([{ evaluation: xEval }, { evaluation: sEval }]);
    const variationSummary = combineRuleSummaries([{ evaluation: sEval }]);
    const all = [...xItems, ...sItems]
      .sort((a, b) => a.i - b.i || a.rule - b.rule)
      .slice(0, MAX_SPC_REPORT_DETAIL_ROWS);
    const report = spcReport({
      violList: all, violationSummary,
      variationViolations: sItems, variationSummary, variationChartLabel: 'S',
      k: M.k, n: M.n, hasSubgroups: true, structure: 'subgroup', typeLabel: 'X̄-S',
      variableName: prepared.variableName, dataRole: prepared.note,
    });
    const labels = labelsFor(M.k);
    return {
      kind: 'spc', title: 'X̄-S 控制图专项报告', subtitle: `${prepared.variableName} · ${prepared.layoutLabel} · ${M.k} 子组 × n=${M.n}`, generatedAt: now(),
      summary: [report.headline, `判读顺序：${report.details.readingOrder}。`, prepared.note], warnings: sEval.viol.size ? ['S 图存在特殊原因信号，先调查组内标准差异常，再解释 X̄ 图。'] : [],
      tables: [
        spcSourceTable,
        { title: '控制限', headers: ['图', 'CL', 'UCL', 'LCL', '异常点数'], rows: [['X̄', fmt(M.xbarbar), fmt(M.uclXs), fmt(M.lclXs), xEval.viol.size], ['S', fmt(M.sCl), fmt(M.uclS), fmt(M.lclS), sEval.viol.size]] },
        {
          title: '判异明细', headers: ['子组', '子图', '准则', '说明'],
          rows: all.map((item) => [labels?.[item.i] ?? item.i + 1, item.chartLabel, item.rule, item.desc]),
          totalRows: violationSummary.pointRuleHitCount,
          note: spcDetailNote(violationSummary, all.length),
        },
      ],
      charts: [
        svgChart(`${prepared.variableName} 的均值控制图 (X̄)`, <ControlChart T={T} data={means} cl={M.xbarbar} ucl={M.uclXs} lcl={M.lclXs} clLabel="X̄" zones={app.spcShowZones} dec={meanDec} h={250} violations={xEval.viol} xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 子组均值`} xLabels={labels} />, 960, 250),
        svgChart(`${prepared.variableName} 的标准差控制图 (S)`, <ControlChart T={T} data={M.svals} cl={M.sCl} ucl={M.uclS} lcl={M.lclS} clLabel={sCenterLabel} zones={app.spcShowZones} dec={Math.min(dataDp + 2, 4)} h={210} violations={sEval.viol} xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 子组标准差`} xLabels={labels} />, 960, 210),
      ],
    };
  }

  // X̄-R
  const ranges = M.subs.map((sub) => sub.range);
  // 阶段口径与 SPC 页/看板/保存记录同源解析(PLATFORM-21):校验失败统一拒绝出结论。
  const stage = resolveSpcStage({
    stageColumn: app.spcStageCol, textCols: prepared.textCols, spcType: effectiveType, hasSubgroups: M.hasSubgroups, pointCount: M.k,
  });
  const stageError = stage.state === 'invalid' ? stage.reason : null;
  if (stageError) {
    return {
      kind: 'spc', title: 'X̄-R 控制图专项报告 · 分阶段未运行', subtitle: prepared.variableName, generatedAt: now(),
      summary: ['分阶段控制图未运行，未生成统计结论。'], warnings: [stageError], tables: [spcSourceTable], charts: [],
    };
  }
  const staged = stage.state === 'active' ? {
    x: stagedXbar(
      M.subs.map((sub) => sub.vals), stage.labels, app.spcRules,
      app.spcSigmaMethod, app.spcRuleK, SPC_REPORT_RULE_OPTIONS,
    ),
    r: stagedRange(
      M.subs.map((sub) => sub.vals), stage.labels, app.spcRules,
      app.spcSigmaMethod, app.spcRuleK, SPC_REPORT_RULE_OPTIONS,
    ),
  } : null;
  if (!staged) {
    const unavailable = shewhartUnavailablePayload('xbar-r', M.k, '子组');
    if (unavailable) return unavailable;
  }
  const x = staged ?? null;
  const xEval = x ? x.x : evalRules(
    means, M.xbarbar, (M.uclX - M.xbarbar) / 3,
    app.spcRules, app.spcRuleK, SPC_REPORT_RULE_OPTIONS,
  );
  const rEval = x ? x.r : evalLimitedRules(
    ranges, M.rCl, M.uclR, M.lclR,
    app.spcRules, app.spcRuleK, undefined, SPC_REPORT_RULE_OPTIONS,
  );
  const xItems = reportRuleItems(xEval, 'X̄');
  const rItems = reportRuleItems(rEval, 'R');
  const violationSummary = combineRuleSummaries([{ evaluation: xEval }, { evaluation: rEval }]);
  const variationSummary = combineRuleSummaries([{ evaluation: rEval }]);
  const all = [...xItems, ...rItems]
    .sort((a, b) => a.i - b.i || a.rule - b.rule)
    .slice(0, MAX_SPC_REPORT_DETAIL_ROWS);
  const stagedXCounts = staged ? violationCountsByStage(xEval.viol, staged.x.segments) : null;
  const stagedRCounts = staged ? violationCountsByStage(rEval.viol, staged.r.segments) : null;
  const report = spcReport({
    violList: all, violationSummary,
    variationViolations: rItems, variationSummary,
    variationChartLabel: 'R',
    k: M.k,
    n: M.n,
    hasSubgroups: true,
    structure: 'subgroup',
    typeLabel: 'X̄-R',
    variableName: prepared.variableName,
    dataRole: prepared.note,
  });
  const labels = prepared.subgroupLabels.length === M.k ? prepared.subgroupLabels : undefined;
  const xProps = staged ? {
    clSeries: staged.x.clSeries, uclSeries: staged.x.uclSeries, lclSeries: staged.x.lclSeries,
    stepSeries: true, stageBoundaries: staged.x.boundaries,
  } : {};
  const rProps = staged ? {
    clSeries: staged.r.clSeries, uclSeries: staged.r.uclSeries, lclSeries: staged.r.lclSeries,
    stepSeries: true, stageBoundaries: staged.r.boundaries,
  } : {};
  return {
    kind: 'spc',
    title: 'X̄-R 控制图专项报告',
    subtitle: `${prepared.variableName} · ${prepared.layoutLabel} · ${M.k} 子组 × n=${M.n}`,
    generatedAt: now(),
    summary: [report.headline, `判读顺序：${report.details.readingOrder}。`, prepared.note],
    warnings: rEval.viol.size ? ['R 图存在特殊原因信号，均值图控制限暂不具备解释基础；应先调查并消除组内变异异常。'] : [],
    tables: [
      spcSourceTable,
      {
        title: '控制限',
        headers: ['图', 'CL', 'UCL', 'LCL', '异常点数'],
        rows: staged
          ? staged.x.segments.flatMap((segment, index) => [
              [`X̄ · ${segment.label}`, fmt(segment.cl), fmt(segment.ucl), fmt(segment.lcl), stagedXCounts![index]],
              [`R · ${staged.r.segments[index].label}`, fmt(staged.r.segments[index].cl), fmt(staged.r.segments[index].ucl), fmt(staged.r.segments[index].lcl), stagedRCounts![index]],
            ])
          : [['X̄', fmt(M.xbarbar), fmt(M.uclX), fmt(M.lclX), xEval.viol.size], ['R', fmt(M.rCl), fmt(M.uclR), fmt(M.lclR), rEval.viol.size]],
      },
      {
        title: '判异明细',
        headers: ['子组', '子图', '准则', '说明'],
        rows: all.map((item) => [labels?.[item.i] ?? item.i + 1, item.chartLabel, item.rule, item.desc]),
        totalRows: violationSummary.pointRuleHitCount,
        note: spcDetailNote(violationSummary, all.length, '准则定义与来源：Nelson (1984) / Minitab 特殊原因检验。'),
      },
    ],
    charts: [
      svgChart(`${prepared.variableName} 的均值控制图 (X̄)`, <ControlChart T={T} data={means} cl={M.xbarbar} ucl={M.uclX} lcl={M.lclX} clLabel="X̄" zones={app.spcShowZones} dec={meanDec} h={250} violations={xEval.viol} xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 子组均值`} xLabels={labels} {...xProps} />, 960, 250),
      svgChart(`${prepared.variableName} 的极差控制图 (R)`, <ControlChart T={T} data={ranges} cl={M.rCl} ucl={M.uclR} lcl={M.lclR} clLabel={rCenterLabel} zones={app.spcShowZones} dec={rangeDec} h={210} violations={rEval.viol} xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 子组极差`} xLabels={labels} {...rProps} />, 960, 210, '必须先判断 R 图是否受控，再解释 X̄ 图。'),
    ],
  };
}

/** 当前页面没有专项构建器时返回 undefined，导出层继续使用通用质量报告。 */
export function buildActiveAnalysisReport(): AnalysisReportPayload | undefined {
  switch (useApp.getState().page) {
    case 'summary': return buildSummaryPayload();
    case 'aql': return buildAqlPayload();
    case 'anova': return useApp.getState().hypoTab === 'anova' ? buildAnovaPayload() : buildHypothesisPayload();
    case 'doe': return buildDoePayload();
    case 'pareto': return useApp.getState().paretoView === 'pareto' ? buildParetoPayload() : buildFishbonePayload();
    case 'spc': return buildSpcPayload();
    case 'capability': return buildCapabilityPayload();
    case 'gagerr': return buildGagePayload();
    default: return undefined;
  }
}

/**
 * 导出底层工作表也必须与当前分析使用同一数据角色。
 * 例如“子组 + 5 个测量列”在原始工作表中是 6 个数值列，但 SPC 专项分析必须排除子组 ID；
 * Excel 的通用数据/摘要 sheet 若继续使用 raw model，会与专项 sheet 自相矛盾。
 */
export function buildActiveAnalysisExport(): {
  report?: AnalysisReportPayload;
  model: VarModel;
  capabilityModel: VarModel;
  spcFamily: SpcChartFamily;
  /** 通用报告 SPC 段的阶段口径(CORE-09):调用方须原样传给 assessSpcCharts 第 5 参。 */
  spcStage: SpcStageResolution;
} {
  const app = useApp.getState();
  const data = useData.getState();
  let model = data.model;
  let capabilityModel = data.model;
  let spcStage: SpcStageResolution = { state: 'off' };
  if ((app.page === 'spc' && app.spcType !== 'p' && app.spcType !== 'c') || app.page === 'capability') {
    const prepared = app.page === 'capability'
      ? resolveCapabilityMeasurementData(data.model, data.textCols)
      : prepareSpcData(data.model, data.textCols, {
          layout: app.spcDataLayout,
          valueColumn: app.spcValueCol,
          subgroupColumn: app.spcSubgroupCol,
          pendingCells: data.pendingCells,
        });
    if (!prepared.model || prepared.error) {
      // 专项页保持优雅降级(与 v1.42.3 基线一致):buildSpcPayload/buildCapabilityPayload 自会生成
      // 「未运行 + 原因」专项报告,四个构建器在 analysis 分支提前返回,raw model 仅提供工作表名,
      // 不会产出自相矛盾的通用 sheet。整体阻断仅适用于无专项载荷兜底的通用报告页(下方分支)。
      return { report: buildActiveAnalysisReport(), model: data.model, capabilityModel: data.model, spcFamily: 'i-mr', spcStage: { state: 'off' } };
    }
    // SPC 与能力稳定性均跟随当前 σ̂ 方法；能力 Cpk 的 sigmaWithin 不受 withSigmaMethod 影响。
    model = app.page === 'spc' ? withSigmaMethod(prepared.model, app.spcSigmaMethod) : prepared.model;
    capabilityModel = withSigmaMethod(prepared.model, app.spcSigmaMethod);
  } else if (app.page === 'spc' && app.spcType === 'p') {
    model = computeVarModel(
      data.pModel.name,
      ['不良数', '样本量'],
      data.pModel.pdef.map((count, index) => [count, data.pModel.pNs[index]]),
    );
    capabilityModel = model;
  } else if (app.page === 'summary') {
    const selected = resolveNumericColumn(data.model, app.activeVar);
    model = computeVarModel(data.model.name, [selected.name], selected.values.map((value) => [value]));
    capabilityModel = model;
  } else if (app.page === 'dashboard' || app.page === 'worksheet' || app.page === 'assistant') {
    const prepared = prepareSpcData(data.model, data.textCols, {
      layout: app.spcDataLayout,
      valueColumn: app.spcValueCol,
      subgroupColumn: app.spcSubgroupCol,
      pendingCells: data.pendingCells,
    });
    if (!prepared.model || prepared.error) throw new Error(prepared.error ?? '当前 SPC 数据角色无效，无法导出');
    model = withSigmaMethod(prepared.model, app.spcSigmaMethod);
    // CORE-09/PLATFORM-21:通用报告 SPC 段与 SPC 页同一阶段口径;阶段校验失败时与页面/看板/
    // 保存记录一样拒绝出结论,不按全局控制限退化导出。
    spcStage = resolveSpcStage({
      stageColumn: app.spcStageCol, textCols: prepared.textCols, spcType: app.spcType, hasSubgroups: model.hasSubgroups, pointCount: model.k,
    });
    if (spcStage.state === 'invalid') {
      throw new Error(`X̄-R 分阶段未运行：${spcStage.reason}；请在控制图页修正阶段列或改为「不分阶段」后再导出`);
    }
    if (app.capSubgroupMode === 'spc') {
      // 能力沿用 SPC 角色时，二者观测完全相同；withSigmaMethod 只改控制图限值，不改能力 sigmaWithin。
      capabilityModel = model;
    } else {
      const capability = resolveCapabilityMeasurementData(data.model, data.textCols);
      if (!capability.model || capability.error) throw new Error(capability.error ?? '当前能力数据角色无效，无法导出');
      capabilityModel = withSigmaMethod(capability.model, app.spcSigmaMethod);
    }
  }
  // UI-12 残余(fix2609k G20 方案 a):总览/工作表/助手页导出的通用报告 SPC 段与质量总览同一视图
  // 图型(spcViewFamilyFor:子组数据选 I-MR 时按全部单值),导出与屏幕同源;能力段由 Modals 在
  // capabilityFamily!==spcFamily 时按能力口径独立计数并披露。
  const spcFamily: SpcChartFamily = app.page === 'dashboard' || app.page === 'worksheet' || app.page === 'assistant'
    ? spcViewFamilyFor(model, app.spcType)
    : spcChartFamilyFor(model, app.spcType);
  return { report: buildActiveAnalysisReport(), model, capabilityModel, spcFamily, spcStage };
}
