/**
 * 把“当前页面正在显示的分析”转换为统一专项报表载荷。
 *
 * 这里刻意复用页面相同的角色解析与 core 结构化报告，导出不得重新猜变量或回落演示。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import {
  analyzeFactorial,
  analyzeDoe,
  anovaGroups,
  buildAnovaGroups,
  buildAnovaStructuredReport,
  buildAqlReportData,
  buildDoeStructuredReport,
  capabilityInputError,
  computeCapability,
  computeGageRR,
  countAnovaPendingCells,
  DEFECTS,
  DOE_DESIGN,
  detectFactorial,
  cusumSeries,
  evalLimitedRules,
  evalRules,
  ewmaSeries,
  factorialAdjustedMainMeans,
  factorialOptimizationDecision,
  factorialModelTerms,
  GAGE_TOLERANCE,
  gageStudyData,
  mainEffectMeans,
  nf,
  isDoeAnalysisColumn,
  linearRegression,
  oneSampleT,
  prepareGageStudy,
  prepareSpcData,
  resolveAnovaMode,
  resolveAnovaNumericRoles,
  resolveDoeColumns,
  resolveDoeBlockValues,
  splitStages,
  stagedRange,
  stagedXbar,
  tInv,
  twoSampleT,
  wideScaleDisparate,
  andersonDarling,
  type AnovaGroup,
  type DoeRunMetadata,
  type VarModel,
} from '../core';
import { useApp } from '../store/appStore';
import { useData } from '../store/dataStore';
import { expandSpcRuleItems } from '../store/analyses';
import { paretoReport, spcReport } from '../ui/reportData';
import { chartTokens } from '../ui/tokens';
import { ControlChart } from '../ui/charts/ControlChart';
import { NormalProbPlot } from '../ui/charts/NormalProbPlot';
import { BoxPlot, GroupedBars, IndividualValuePlot, IntervalPlot, ParetoChart } from '../ui/charts/misc';
import { ScatterPlot } from '../ui/charts/ScatterPlot';
import { Histogram } from '../ui/charts/Histogram';
import { EffectsBar, MainEffects } from '../ui/charts/doe';
import { OcCurveChart } from '../ui/charts/OcCurveChart';
import { FishboneChart } from '../ui/pages/Fishbone';
import { loadFishboneState } from '../store/fishboneStore';
import type { AnalysisReportChart, AnalysisReportPayload } from './analysisReportModel';

const T = chartTokens('经典', true);
const now = () => new Date().toLocaleString('zh-CN', { hour12: false });
const svgChart = (title: string, element: React.ReactElement, width: number, height: number, note?: string): AnalysisReportChart => ({
  title,
  svg: renderToStaticMarkup(element),
  width,
  height,
  note,
});
const fmt = (value: number | null | undefined, digits = 4) => {
  if (value == null || Number.isNaN(value)) return '—';
  if (value === Infinity) return '+∞';
  if (value === -Infinity) return '−∞';
  return nf(value, digits);
};

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

function buildAqlPayload(): AnalysisReportPayload {
  const app = useApp.getState();
  const report = buildAqlReportData(app.aqlLot, app.aqlLevel, app.aqlAQL, app.aqlSwitch);
  const p = report.plan;
  const latest = report.latestRecord;
  const summary = [
    `${report.stateLabel} · ${report.sourceTable} · 初始字码 ${report.initialCode} → 执行字码 ${p.code}`,
    p.fullInspect
      ? `查表样本量达到批量，执行 100% 全检：N=${p.n}，Ac=${p.ac}，Re=${p.re}`
      : `抽样方案 n=${p.n}，Ac=${p.ac}，Re=${p.re}；生产方风险 α=${fmt(report.producerRiskPct, 2)}%，RQL(β=10%)=${fmt(report.rqlPct, 2)}%`,
    latest
      ? `最近批次 ${latest.batchId}：抽检/全检 ${latest.sampleSize} 件，不合格 ${latest.nonconforming} 件，判定${latest.decision === 'accepted' ? '接收' : '不接收'}，检验人 ${latest.inspector}`
      : '尚未记录实际批次检验结果；当前仅为方案设计结果。',
  ];
  const warnings = [
    report.suspended ? '加严检验累计 5 批不接收，抽样检验已暂停；须确认纠正措施有效后才能恢复。' : '',
    report.state === 'normal' && report.switchingScore >= 30 && (!report.productionSteady || !report.reducedApproved)
      ? '转移得分已达到 30，但生产稳定/负责部门批准条件未同时满足，不能转放宽检验。'
      : '',
  ].filter(Boolean);
  const charts = p.fullInspect || report.suspended ? [] : [
    svgChart(
      'OC 特性曲线',
      <OcCurveChart T={T} n={p.n} ac={p.ac} pmax={Math.min(1, Math.max(0.1, (report.rqlPct ?? 40) / 80))} aqlP={report.aql / 100} rqlP={report.rqlPct == null ? undefined : report.rqlPct / 100} />,
      960,
      330,
      'AQL 点显示生产方接收概率；RQL 点对应使用方风险 β=10%。',
    ),
  ];
  return {
    kind: 'aql',
    title: 'AQL 接收抽样专项报告',
    subtitle: `${report.standard} · ${report.samplingType} · 批量 ${report.lot} · 水平 ${report.level} · AQL ${report.aql}`,
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
        headers: ['时间', '批次号', '检验人', '初检/复验', '批量 N', '水平', 'AQL', '状态', '主表', '初始字码', '执行字码', '检验量', '全检', 'Ac/Re', '不合格数', '判定', '转移后', '得分', '备注'],
        rows: report.records.map((record) => [
          record.inspectedAt, record.batchId, record.inspector, record.originalInspection ? '初检' : '复验',
          record.lot, record.level, record.aql, record.stateBefore, record.sourceTable, record.initialCode, record.finalCode,
          record.sampleSize, record.fullInspection ? '是' : '否', `${record.acceptanceNumber}/${record.rejectionNumber}`,
          record.nonconforming, record.decision === 'accepted' ? '接收' : '不接收', record.stateAfter, record.switchingScoreAfter, record.note,
        ]),
        note: '复验批保留追溯记录，但不计入 GB/T 2828.1 第 9.3 条转移规则。',
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
    const roles = resolveAnovaNumericRoles(M.colNames, rows, app.anovaRespName, app.anovaFactorName);
    responseName = mode === 'wide' ? '测量值' : M.colNames[roles.respIdx] ?? app.anovaRespName ?? '响应';
    factorName = mode === 'stacked'
      ? (app.anovaFactorName ?? eligibleText[0]?.name ?? '分组')
      : mode === 'numfactor' ? (M.colNames[roles.factorIdx] ?? app.anovaFactorName ?? '因子') : '测量列';
    const built = buildAnovaGroups(mode, M.colNames, rows, eligibleText, responseName, factorName);
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
  const observations = groups.flatMap((group, groupIndex) => group.vals.map((value, index) => ({
    row: hasWorksheetRows ? group.rowIndices![index] + 1 : index + 1,
    groupIndex,
    factor: group.name,
    value,
  }))).sort((a, b) => hasWorksheetRows ? a.row - b.row || a.groupIndex - b.groupIndex : a.groupIndex - b.groupIndex || a.row - b.row);
  return {
    kind: 'anova',
    usesWorksheet: !isDemo,
    title: '单因子 ANOVA 专项报告',
    subtitle: `${responseName} vs ${factorName} · ${modeLabel}`,
    generatedAt: now(),
    summary: [
      `F(${factor.df}, ${error.df})=${fmt(factor.f, 4)}，P=${fmt(factor.p, 6)}；${report.significant ? '组间均值差异显著' : '未发现显著组间差异'}（α=${fmt(report.alpha, 2)}）。`,
      `残差按${report.diagnostics.worksheetOrder ? '原工作表采集行序' : '分组顺序'}输出；组均值区间采用 ANOVA 合并误差 MSE。`,
    ],
    warnings: [
      isDemo ? '本报告使用内置的「设备 A/B/C × 直径」演示研究，不得当作用户数据结论。' : '',
      groups.some((group) => group.vals.length < 5) ? '存在样本量小于 5 的组，检验功效有限，建议补充重复观测。' : '',
    ].filter(Boolean),
    tables: [
      {
        title: '用于 ANOVA 的原始观测',
        headers: [hasWorksheetRows ? '工作表行' : '组内序号', factorName, responseName],
        rows: observations.map((observation) => [observation.row, observation.factor, fmt(observation.value, 8)]),
        note: '该表保留实际分组角色和响应值，可用于复核方差分析。',
      },
      {
        title: '方差分析表',
        headers: ['来源', 'DF', 'SS', 'MS', 'F', 'P'],
        rows: report.sources.map((source) => [source.source, source.df, fmt(source.ss, 6), fmt(source.ms, 6), fmt(source.f, 5), fmt(source.p, 6)]),
      },
      {
        title: '分组描述统计与合并误差置信区间',
        headers: ['组', 'N', '均值', '标准差', '95% CI 下限', '95% CI 上限'],
        rows: report.groups.map((group) => [group.name, group.n, fmt(group.mean), fmt(group.stDev), fmt(group.ciLow), fmt(group.ciHigh)]),
      },
      {
        title: '残差诊断数据',
        headers: ['观测序', '拟合值', '残差'],
        rows: residuals.map((residual, index) => [index + 1, fmt(report.diagnostics.fits[index]), fmt(residual)]),
      },
    ],
    charts: [
      svgChart('个体值图', <IndividualValuePlot T={T} groups={groups} />, 960, 320),
      svgChart('均值与 95% 置信区间', <IntervalPlot T={T} groups={groups} pooledError={{ mse: error.ms ?? 0, df: error.df }} />, 960, 320),
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
    try {
      const result = oneSampleT(values, mu0);
      return {
        kind: 't1', usesWorksheet: true, title: '单样本 t 检验专项报告', subtitle: `${columnName} vs 目标 μ₀=${fmt(mu0, 8)}`, generatedAt: now(),
        summary: [`t(${fmt(result.df, 2)})=${fmt(result.t, 5)}，P=${fmt(result.p, 6)}；${result.significant ? '样本均值与目标存在显著差异' : '未发现样本均值显著偏离目标'}（双侧 α=0.05）。`],
        warnings: M.isDemo ? ['当前为出厂演示数据集，不得当作用户过程结论。'] : [],
        tables: [
          { title: '原始样本', headers: ['观测', columnName], rows: values.map((value, index) => [index + 1, fmt(value, 8)]) },
          { title: '检验结果', headers: ['N', '均值', 'μ₀', 't', 'df', 'P', '95% CI 下限', '95% CI 上限', 'SE'], rows: [[values.length, fmt(result.estimate), fmt(mu0), fmt(result.t), fmt(result.df, 2), fmt(result.p, 6), fmt(result.ciLow), fmt(result.ciHigh), fmt(result.se)]] },
        ],
        charts: [svgChart(`${columnName} 的箱线图`, <BoxPlot T={T} groups={[{ name: columnName, vals: values }]} />, 960, 320)],
      };
    } catch (error) {
      return unrunPayload('t1', '单样本 t 检验专项报告', columnName, `无法计算：${(error as Error).message}`);
    }
  }

  if (app.hypoTab === 't2') {
    const multi = M.colNames.length >= 2;
    const demo = anovaGroups();
    const first = indexFor(app.t2ColAName, 0);
    const namedSecond = indexFor(app.t2ColBName, multi ? 1 : 0);
    const second = multi && namedSecond === first ? (first === 0 ? 1 : 0) : namedSecond;
    const groups = multi
      ? [
          { name: M.colNames[first], vals: M.subs.map((sub) => sub.vals[first]) },
          { name: M.colNames[second], vals: M.subs.map((sub) => sub.vals[second]) },
        ]
      : [demo[0], demo[1]];
    const pending = multi ? pendingIn([first, second]) : 0;
    if (pending > 0) return unrunPayload('t2', '双样本 t 检验专项报告', `${groups[0].name} vs ${groups[1].name}`, `所选样本列还有 ${pending} 个待录入单元格。`);
    try {
      const result = twoSampleT(groups[0].vals, groups[1].vals);
      return {
        kind: 't2', usesWorksheet: multi, title: '双样本 t 检验（Welch）专项报告', subtitle: `${groups[0].name} vs ${groups[1].name}`, generatedAt: now(),
        summary: [`t(${fmt(result.df, 2)})=${fmt(result.t, 5)}，P=${fmt(result.p, 6)}；${result.significant ? '两组均值存在显著差异' : '未发现两组均值显著差异'}（Welch 不等方差，双侧 α=0.05）。`],
        warnings: !multi ? ['当前数据只有 1 列，页面与报告均使用内置设备 A/B 演示样本，非用户数据。'] : M.isDemo ? ['当前为出厂演示数据集。'] : [],
        tables: [
          { title: '原始样本', headers: ['样本', '组内序号', '观测'], rows: groups.flatMap((group) => group.vals.map((value, index) => [group.name, index + 1, fmt(value, 8)])) },
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
      summary: [`${yName} = ${fmt(result.intercept, 6)} ${result.slope >= 0 ? '+' : '−'} ${fmt(Math.abs(result.slope), 6)} × ${xName}；R²=${fmt(result.r2, 5)}，P=${fmt(result.p, 6)}，斜率${result.significant ? '显著' : '不显著'}。`],
      warnings: M.isDemo ? ['当前为出厂演示数据集。'] : [],
      tables: [
        { title: '原始 X/Y 观测', headers: ['行', xName, yName], rows: xs.map((value, index) => [index + 1, fmt(value, 8), fmt(ys[index], 8)]) },
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
          rows: demo.terms.map((term) => [term.name, fmt(term.v), fmt(term.coef), term.sig ? '是' : '否']),
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
  const { factorIdx, respIdx } = resolveDoeColumns(M.colNames, app.doeFactorCols, app.doeRespCol);
  if (factorIdx.length < 2 || respIdx < 0) {
    return unrunPayload('doe', '因子试验设计（DOE）专项报告', M.name, '需要至少 2 个合法因子列和 1 个响应列；标准序、运行序、区组及旧的 DOE 输出列不会被当作因子。');
  }
  const response = rows.map((row) => row[respIdx]);
  const blocks = resolveDoeBlockValues(M.colNames, rows, data.textCols);
  const detected = detectFactorial(
    factorIdx.map((index) => ({ name: M.colNames[index], values: rows.map((row) => row[index]) })),
    response,
    { blocks },
  );
  if (!detected.ok) {
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
  const available = factorialModelTerms(detected.design.factorNames);
  const selected = app.doeModelTerms?.filter((term) => available.includes(term));
  const result = analyzeFactorial(detected.design, {
    terms: selected?.length ? selected : undefined,
    includeCurvature: app.doeIncludeCurvature,
  });
  const responseName = M.colNames[respIdx];
  const report = buildDoeStructuredReport(detected.design, result, responseName, doeRunMetadata(M.colNames, rows, data.textCols));
  const sig = report.coefficients.filter((term) => term.term !== '常量' && term.significant).map((term) => term.term);
  const main = factorialAdjustedMainMeans(result, detected.design);
  const isT = result.method === 'ttest';
  const finiteT = result.terms.map((term) => Math.abs(term.tStat ?? 0)).filter(Number.isFinite);
  const capT = (finiteT.length ? Math.max(...finiteT) : 1) * 1.5 + 1;
  const bars = result.terms.map((term) => ({ name: term.name, abs: isT ? (Number.isFinite(term.tStat) ? Math.abs(term.tStat!) : capT) : Math.abs(term.effect) }));
  const ref = isT ? tInv(0.975, result.dfResid ?? 1) : (result.me ?? 0);
  const residuals = result.stdResiduals ?? result.residuals;
  const optimization = factorialOptimizationDecision(result, detected.design);
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
  const optimizationSummary = optimization.status === 'no-significant-effect'
    ? '当前未检出显著工艺效应，不推荐任意角点作为最优设置；建议增加重复或中心点。'
    : optimization.status === 'significant-curvature'
      ? '中心点曲率显著，两水平线性模型不能可靠给出最优角点；应升级为响应曲面设计。'
      : optimization.status === 'tied'
        ? `当前模型有 ${optimization.optimum!.ties.length} 个并列最大角点，无唯一最优组合；共同设置为：${fixedSettings || '无（所有因子均存在并列设置）'}；并列组合：${tiedSettings}${optimization.optimum!.ties.length > 4 ? `；另有 ${optimization.optimum!.ties.length - 4} 个` : ''}。`
        : `按当前完整拟合模型枚举角点，唯一最大组合为：${uniqueSettings}；需用确认试验验证。`;
  return {
    kind: 'doe',
    usesWorksheet: true,
    title: '因子试验设计（DOE）专项报告',
    subtitle: `${report.factors.length} 因子 · ${report.runCount} 运行 · 响应 ${responseName} · ${report.method === 'ttest' ? 't 检验' : 'Lenth 检验'}`,
    generatedAt: now(),
    summary: [
      sig.length ? `显著项：${sig.join('、')}。` : '当前模型未检出显著效应项。',
      `模型项 ${report.model.requestedTerms.join('、') || '无'}；${report.model.includeCurvature ? '包含中心点曲率' : '不包含曲率'}；残差自由度 ${report.model.residualDf ?? '—'}。`,
      result.block ? `已将 ${result.block.levels.length} 个区组（DF=${result.block.df}）作为扰动项调整；主效应图为区组等权调整后的模型均值，与区组混杂的交互项不单独解释。` : '主效应图使用当前拟合模型的调整均值；未检测到多区组调整。',
      optimizationSummary,
    ],
    warnings: [
      report.model.droppedTerms.length ? `以下项因别名/秩亏不能单独估计并已剔除：${report.model.droppedTerms.join('、')}。` : '',
    ].filter(Boolean),
    tables: [
      {
        title: '效应与系数',
        headers: ['项', '效应', '系数', 't', 'P', '显著'],
        rows: report.coefficients.map((term) => [term.term, fmt(term.effect), fmt(term.coefficient), fmt(term.t), fmt(term.p, 6), term.significant ? '是' : '否']),
      },
      {
        title: '设计矩阵、拟合与残差',
        headers: ['行', '标准序', '运行序', '区组', '点类型', ...report.factors.map((factor) => factor.name), '观测', '拟合', '残差', '标准化残差'],
        rows: report.runs.map((run) => [
          run.row, run.standardOrder ?? '—', run.runOrder, run.block ?? '—', run.pointType,
          ...run.factorValues.map((value) => fmt(value, 6)), fmt(run.observed), fmt(run.fitted), fmt(run.residual), fmt(run.standardizedResidual),
        ]),
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
      svgChart('残差正态概率图', <NormalProbPlot T={T} data={residuals} h={280} />, 960, 280),
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
  const report = paretoReport({ rows: source, mergeOther: app.paretoMergeOther, threshold: app.paretoThreshold });
  const sourceName = hasImportedData ? model.name : '内置示例（非用户数据）';
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
        rows: source.map((row) => [row.name, row.count]),
        note: hasImportedData ? '保留导入时的全部类别，便于复算合并阈值。' : '内置演示原始数据。',
      },
      {
        title: '缺陷频数与累计贡献',
        headers: ['类别', '频数', '占比', '累计占比', '合并为其他'],
        rows: report.rows.map((row) => [row.name, row.count, `${fmt(row.percentage, 2)}%`, `${fmt(row.cumulativePercentage, 2)}%`, row.mergedOther ? '是' : '否']),
        note: report.mergeOther ? `累计阈值 ${fmt(report.threshold * 100, 0)}%，合并 ${report.mergedCategoryCount} 个尾部类别。` : '未启用尾部类别合并。',
      },
    ],
    charts: [svgChart('帕累托图', <ParetoChart T={T} rows={report.rows.map((row) => ({ name: row.name, count: row.count }))} />, 960, 300)],
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
  const prepared = prepareSpcData(data.model, data.textCols, {
    layout: app.spcDataLayout,
    valueColumn: app.spcValueCol,
    subgroupColumn: app.spcSubgroupCol,
    pendingCells: data.pendingCells,
  });
  if (prepared.error || !prepared.model) {
    return unrunPayload('capability', '过程能力分析专项报告', data.model.name, prepared.error ?? '当前测量数据角色无效。', true);
  }
  const M = prepared.model;
  const spec = {
    lsl: app.lslOn ? app.lsl : null,
    tgt: app.tgt,
    usl: app.uslOn ? app.usl : null,
  };
  const inputError = capabilityInputError(M.all, M.sigmaWithin, spec);
  if (inputError) return unrunPayload('capability', '过程能力分析专项报告', data.model.name, inputError, true);
  const cap = computeCapability(M.all, M.sigmaWithin, spec);
  const ad = M.all.length >= 8 ? andersonDarling(M.all) : null;
  const verdict = cap.verdict === 'sufficient' ? '能力充足' : cap.verdict === 'marginal' ? '能力临界' : '能力不足';
  const sourceTable = M.hasSubgroups
    ? {
        title: '用于能力分析的解析子组数据',
        headers: ['子组', ...M.colNames],
        rows: M.subs.map((subgroup, index) => [prepared.subgroupLabels[index] ?? subgroup.i, ...subgroup.vals.map((value) => fmt(value, 8))]),
        note: prepared.note,
      }
    : {
        title: '用于能力分析的解析单值数据',
        headers: ['观测', prepared.variableName],
        rows: M.indiv.map((value, index) => [prepared.subgroupLabels[index] ?? index + 1, fmt(value, 8)]),
        note: prepared.note,
      };
  return {
    kind: 'capability',
    usesWorksheet: true,
    title: '过程能力分析专项报告',
    subtitle: `${prepared.variableName} · ${prepared.layoutLabel} · N=${M.all.length}`,
    generatedAt: now(),
    summary: [
      `Cpk=${fmt(cap.cpk, 4)}，Ppk=${fmt(cap.ppk, 4)}，${verdict}。`,
      `规格：${app.lslOn ? `LSL=${fmt(app.lsl, 6)}` : '无下限'} / Target=${fmt(app.tgt, 6)} / ${app.uslOn ? `USL=${fmt(app.usl, 6)}` : '无上限'}；${prepared.note}。`,
      ad ? `Anderson-Darling A²*=${fmt(ad.a2star, 4)}，P=${fmt(ad.p, 6)}，${ad.normal ? '未拒绝正态性' : '显著偏离正态分布'}。` : '样本量不足 8，未执行 Anderson-Darling 正态性检验。',
    ],
    warnings: [
      !app.lslOn || !app.uslOn ? '当前为单侧规格，Cp/Pp/Cpm 不适用；Cpk 退化为启用一侧的 CPU 或 CPL。' : '',
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
  const prepared = prepareGageStudy(data.model, data.textCols, {
    valueColumn: app.gageValueName,
    partColumn: app.gagePartName,
    operatorColumn: app.gageOperatorName,
    pendingCells: data.pendingCells,
  });
  if (requestedReal && !prepared.ok) {
    return unrunPayload('gagerr', '测量系统分析 Gage R&R 专项报告', data.model.name, prepared.reason, true);
  }
  const observations = requestedReal && prepared.ok ? prepared.study.observations : gageStudyData();
  const tolerance = requestedReal ? Math.abs(app.usl - app.lsl) : GAGE_TOLERANCE;
  let result: ReturnType<typeof computeGageRR>;
  try {
    result = computeGageRR(observations, tolerance);
  } catch (error) {
    return unrunPayload('gagerr', '测量系统分析 Gage R&R 专项报告', data.model.name, (error as Error).message, requestedReal);
  }
  const realStudy = requestedReal && prepared.ok ? prepared.study : null;
  const verdict = result.verdict === 'acceptable' ? '可接受（<10%）' : result.verdict === 'marginal' ? '临界（10–30%）' : '不可接受（>30%）';
  const cats = result.components.slice(0, 4).map((component) => ({
    name: component.source.trim(),
    contrib: component.pctContribution,
    study: component.pctStudyVar,
    tol: component.pctTolerance,
  }));
  return {
    kind: 'gagerr',
    usesWorksheet: requestedReal,
    title: '测量系统分析 Gage R&R 专项报告',
    subtitle: requestedReal && realStudy
      ? `${realStudy.valueName} · 部件 ${realStudy.partName} · 操作员 ${realStudy.operatorName} · ${realStudy.partLabels.length}×${realStudy.operatorLabels.length}×${realStudy.repeats}`
      : '内置 10 部件 × 3 操作员 × 2 重复演示研究 · 非用户数据',
    generatedAt: now(),
    summary: [`合计 Gage R&R=${fmt(result.totalGageRR, 3)}%（研究变异），测量系统${verdict}。`],
    warnings: requestedReal ? [] : ['本报告使用内置交叉 Gage R&R 演示研究，不得当作用户测量系统结论。'],
    tables: [
      {
        title: requestedReal ? '导入的交叉研究原始观测' : '演示交叉研究原始观测',
        headers: ['部件', '操作员', '重复', realStudy?.valueName ?? '测量值'],
        rows: observations.map((observation) => [
          realStudy?.partLabels[observation.part] ?? observation.part + 1,
          realStudy?.operatorLabels[observation.operator] ?? observation.operator + 1,
          observation.trial + 1,
          fmt(observation.value, 8),
        ]),
      },
      {
        title: '方差分量与研究变异',
        headers: ['来源', '方差分量', '%贡献', '%研究变异', '%公差'],
        rows: result.components.map((component) => [component.source, fmt(component.variance, 8), fmt(component.pctContribution), fmt(component.pctStudyVar), fmt(component.pctTolerance)]),
        note: `公差宽度=${fmt(tolerance, 8)}；判定阈值按 AIAG 常用的 <10% / 10–30% / >30%。`,
      },
    ],
    charts: [svgChart('Gage R&R 变异分量', <GroupedBars T={T} cats={cats} />, 960, 300)],
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
    const evaluated = evalLimitedRules(values, cl, ucl, lcl, app.spcRules);
    const items = expandSpcRuleItems(evaluated.viol, evaluated.list, isP ? 'P' : 'C');
    const typeLabel = isP ? 'P' : 'C';
    const modelName = isP ? data.pModel.name : data.cModel.name;
    const sampleSize = isP ? data.pModel.pN : 1;
    const report = spcReport({
      violList: items, k: values.length, n: sampleSize, hasSubgroups: false,
      structure: isP ? 'attribute-p' : 'attribute-c', typeLabel,
      variableName: isP ? '不良率' : '单位缺陷数', dataRole: isP ? '不合格品数 / 每批检验数' : '每单位缺陷数',
    });
    return {
      kind: 'spc', title: `${typeLabel} 控制图专项报告`, subtitle: `${modelName} · ${values.length} 个点`, generatedAt: now(),
      summary: [report.headline], warnings: [],
      tables: [
        {
          title: `用于 ${typeLabel} 控制图的原始计数数据`,
          headers: isP ? ['样本', '不合格品数', '检验数', '不良率'] : ['单位', '缺陷数'],
          rows: values.map((value, index) => isP
            ? [index + 1, data.pModel.pdef[index], data.pModel.pN, fmt(value, 8)]
            : [index + 1, data.cModel.cdata[index]]),
          note: isP ? '不良率 = 不合格品数 / 每批检验数。' : '每个点为一个相同机会区域/单位的缺陷数。',
        },
        { title: '控制限', headers: ['图', 'CL', 'UCL', 'LCL', '异常点数'], rows: [[typeLabel, fmt(cl), fmt(ucl), fmt(lcl), new Set(items.map((item) => item.i)).size]] },
        { title: '判异明细', headers: ['点', '准则', '说明'], rows: items.map((item) => [item.i + 1, item.rule, item.desc]), note: '属性图按适用性执行 Nelson/Minitab 准则 1–4。' },
      ],
      charts: [svgChart(`${typeLabel} 控制图 · ${modelName}`, <ControlChart T={T} data={values} cl={cl} ucl={ucl} lcl={lcl} clLabel={isP ? 'p̄' : 'c̄'} zones h={300} violations={evaluated.viol} xLabel={isP ? '样本序号' : '单位序号'} yLabel={isP ? '样本不良率' : '单位缺陷数'} />, 960, 300)],
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
  const M = prepared.model;
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
  const spcSourceTable = M.hasSubgroups
    ? {
        title: '用于控制图的解析子组数据',
        headers: ['子组', ...(stageValues?.length === M.k ? ['阶段'] : []), ...M.colNames],
        rows: M.subs.map((sub, index) => [
          sourceLabels?.[index] ?? sub.i,
          ...(stageValues?.length === M.k ? [stageValues[index]] : []),
          ...sub.vals.map((value) => fmt(value, 8)),
        ]),
        note: prepared.note,
      }
    : {
        title: '用于控制图的解析单值数据',
        headers: ['观测', prepared.variableName],
        rows: M.indiv.map((value, index) => [labelsFor(M.indiv.length)?.[index] ?? index + 1, fmt(value, 8)]),
        note: prepared.note,
      };

  if (effectiveType === 'i-mr') {
    const iEval = evalRules(M.indiv, M.indMean, (M.iUcl - M.indMean) / 3, app.spcRules);
    const mr = M.mr.slice(1) as number[];
    const mrEval = evalLimitedRules(mr, M.mrbar, M.mrUcl, 0, app.spcRules);
    const iItems = expandSpcRuleItems(iEval.viol, iEval.list, 'I');
    const mrItems = expandSpcRuleItems(mrEval.viol, mrEval.list, 'MR').map((item) => ({ ...item, i: item.i + 1 }));
    const report = spcReport({
      violList: [...iItems, ...mrItems], variationViolations: mrItems, variationChartLabel: 'MR',
      k: M.indiv.length, n: 1, hasSubgroups: false, structure: 'individual', typeLabel: 'I-MR',
      variableName: prepared.variableName, dataRole: prepared.note,
    });
    const labels = labelsFor(M.indiv.length);
    return {
      kind: 'spc', title: 'I-MR 控制图专项报告', subtitle: `${prepared.variableName} · ${prepared.layoutLabel} · ${M.indiv.length} 个观测`, generatedAt: now(),
      summary: [report.headline, `判读顺序：${report.details.readingOrder}。`, prepared.note],
      warnings: mrItems.length ? ['MR 图存在特殊原因信号，先调查相邻观测变异，再解释 I 图。'] : [],
      tables: [
        spcSourceTable,
        { title: '控制限', headers: ['图', 'CL', 'UCL', 'LCL', '异常点数'], rows: [['I', fmt(M.indMean), fmt(M.iUcl), fmt(M.iLcl), new Set(iItems.map((item) => item.i)).size], ['MR', fmt(M.mrbar), fmt(M.mrUcl), '0', new Set(mrItems.map((item) => item.i)).size]] },
        { title: '判异明细', headers: ['观测', '子图', '准则', '说明'], rows: [...iItems, ...mrItems].map((item) => [labels?.[item.i] ?? item.i + 1, item.chartLabel, item.rule, item.desc]) },
      ],
      charts: [
        svgChart(`${prepared.variableName} 的单值控制图 (I)`, <ControlChart T={T} data={M.indiv} cl={M.indMean} ucl={M.iUcl} lcl={M.iLcl} clLabel="X̄" zones h={250} violations={iEval.viol} xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 单值`} xLabels={labels} />, 960, 250),
        svgChart(`${prepared.variableName} 的移动极差图 (MR)`, <ControlChart T={T} data={mr} cl={M.mrbar} ucl={M.mrUcl} lcl={0} clLabel="MR̄" h={210} violations={mrEval.viol} xIndexOffset={1} xLabel="观测序号（MR 从第 2 个观测开始）" yLabel={`${prepared.variableName} · 移动极差`} xLabels={labels?.slice(1)} />, 960, 210),
      ],
    };
  }

  if (effectiveType === 'ewma' || effectiveType === 'cusum') {
    const source = M.hasSubgroups ? means : M.indiv;
    const mu = M.hasSubgroups ? M.xbarbar : M.indMean;
    const sigma = M.hasSubgroups ? M.sigmaWithin / Math.sqrt(M.n) : M.iSig;
    const isEwma = effectiveType === 'ewma';
    const ewma = isEwma ? ewmaSeries(source, mu, sigma) : null;
    const cusum = isEwma ? null : cusumSeries(source, mu, sigma, 0.5, M.hasSubgroups ? 4 : 5);
    const viol = ewma?.viol ?? cusum!.viol;
    const values = ewma?.z ?? cusum!.cp;
    const typeLabel = isEwma ? 'EWMA' : 'CUSUM';
    return {
      kind: 'spc', title: `${typeLabel} 控制图专项报告`, subtitle: `${prepared.variableName} · ${source.length} 个点`, generatedAt: now(),
      summary: [viol.size ? `${typeLabel} 检出 ${viol.size} 个超限点，存在小漂移/累积偏移信号。` : `${typeLabel} 未检出超限点。`, prepared.note], warnings: [],
      tables: [spcSourceTable, { title: '超限点', headers: ['点', '说明'], rows: [...viol].sort((a, b) => a - b).map((index) => [index + 1, isEwma ? 'EWMA 超出时变控制限' : 'CUSUM 超出判定限 H']) }],
      charts: [svgChart(
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
    const xEval = evalRules(means, M.xbarbar, (M.uclXs - M.xbarbar) / 3, app.spcRules);
    const sEval = evalLimitedRules(M.svals, M.sbar, M.uclS, M.lclS, app.spcRules);
    const xItems = expandSpcRuleItems(xEval.viol, xEval.list, 'X̄');
    const sItems = expandSpcRuleItems(sEval.viol, sEval.list, 'S');
    const all = [...xItems, ...sItems];
    const report = spcReport({
      violList: all, variationViolations: sItems, variationChartLabel: 'S',
      k: M.k, n: M.n, hasSubgroups: true, structure: 'subgroup', typeLabel: 'X̄-S',
      variableName: prepared.variableName, dataRole: prepared.note,
    });
    const labels = labelsFor(M.k);
    return {
      kind: 'spc', title: 'X̄-S 控制图专项报告', subtitle: `${prepared.variableName} · ${prepared.layoutLabel} · ${M.k} 子组 × n=${M.n}`, generatedAt: now(),
      summary: [report.headline, `判读顺序：${report.details.readingOrder}。`, prepared.note], warnings: sItems.length ? ['S 图存在特殊原因信号，先调查组内标准差异常，再解释 X̄ 图。'] : [],
      tables: [
        spcSourceTable,
        { title: '控制限', headers: ['图', 'CL', 'UCL', 'LCL', '异常点数'], rows: [['X̄', fmt(M.xbarbar), fmt(M.uclXs), fmt(M.lclXs), new Set(xItems.map((item) => item.i)).size], ['S', fmt(M.sbar), fmt(M.uclS), fmt(M.lclS), new Set(sItems.map((item) => item.i)).size]] },
        { title: '判异明细', headers: ['子组', '子图', '准则', '说明'], rows: all.map((item) => [labels?.[item.i] ?? item.i + 1, item.chartLabel, item.rule, item.desc]) },
      ],
      charts: [
        svgChart(`${prepared.variableName} 的均值控制图 (X̄)`, <ControlChart T={T} data={means} cl={M.xbarbar} ucl={M.uclXs} lcl={M.lclXs} clLabel="X̄" zones h={250} violations={xEval.viol} xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 子组均值`} xLabels={labels} />, 960, 250),
        svgChart(`${prepared.variableName} 的标准差控制图 (S)`, <ControlChart T={T} data={M.svals} cl={M.sbar} ucl={M.uclS} lcl={M.lclS} clLabel="S̄" h={210} violations={sEval.viol} xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 子组标准差`} xLabels={labels} />, 960, 210),
      ],
    };
  }

  // X̄-R
  const ranges = M.subs.map((sub) => sub.range);
  const useStage = stageValues && stageValues.length === M.k && splitStages(stageValues).length >= 2;
  const staged = useStage ? { x: stagedXbar(M.subs.map((sub) => sub.vals), stageValues!, app.spcRules), r: stagedRange(M.subs.map((sub) => sub.vals), stageValues!, app.spcRules) } : null;
  const x = staged ?? null;
  const xEval = x ? { viol: x.x.viol, list: x.x.list } : evalRules(means, M.xbarbar, (M.uclX - M.xbarbar) / 3, app.spcRules);
  const rEval = x ? { viol: x.r.viol, list: x.r.list } : evalLimitedRules(ranges, M.rbar, M.uclR, M.lclR, app.spcRules);
  const xItems = expandSpcRuleItems(xEval.viol, xEval.list, 'X̄');
  const rItems = expandSpcRuleItems(rEval.viol, rEval.list, 'R');
  const all = [...xItems, ...rItems];
  const report = spcReport({
    violList: all,
    variationViolations: rItems,
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
    warnings: rItems.length ? ['R 图存在特殊原因信号，均值图控制限暂不具备解释基础；应先调查并消除组内变异异常。'] : [],
    tables: [
      spcSourceTable,
      {
        title: '控制限',
        headers: ['图', 'CL', 'UCL', 'LCL', '异常点数'],
        rows: staged
          ? staged.x.segments.flatMap((segment, index) => [
              [`X̄ · ${segment.label}`, fmt(segment.cl), fmt(segment.ucl), fmt(segment.lcl), new Set(xItems.filter((item) => item.i >= segment.start && item.i <= segment.end).map((item) => item.i)).size],
              [`R · ${staged.r.segments[index].label}`, fmt(staged.r.segments[index].cl), fmt(staged.r.segments[index].ucl), fmt(staged.r.segments[index].lcl), new Set(rItems.filter((item) => item.i >= segment.start && item.i <= segment.end).map((item) => item.i)).size],
            ])
          : [['X̄', fmt(M.xbarbar), fmt(M.uclX), fmt(M.lclX), new Set(xItems.map((item) => item.i)).size], ['R', fmt(M.rbar), fmt(M.uclR), fmt(M.lclR), new Set(rItems.map((item) => item.i)).size]],
      },
      {
        title: '判异明细',
        headers: ['子组', '子图', '准则', '说明'],
        rows: all.map((item) => [labels?.[item.i] ?? item.i + 1, item.chartLabel, item.rule, item.desc]),
        note: '准则定义与来源：Nelson (1984) / Minitab 特殊原因检验。',
      },
    ],
    charts: [
      svgChart(`${prepared.variableName} 的均值控制图 (X̄)`, <ControlChart T={T} data={means} cl={M.xbarbar} ucl={M.uclX} lcl={M.lclX} clLabel="X̄" zones h={250} violations={xEval.viol} xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 子组均值`} xLabels={labels} {...xProps} />, 960, 250),
      svgChart(`${prepared.variableName} 的极差控制图 (R)`, <ControlChart T={T} data={ranges} cl={M.rbar} ucl={M.uclR} lcl={M.lclR} clLabel="R̄" h={210} violations={rEval.viol} xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 子组极差`} xLabels={labels} {...rProps} />, 960, 210, '必须先判断 R 图是否受控，再解释 X̄ 图。'),
    ],
  };
}

/** 当前页面没有专项构建器时返回 undefined，导出层继续使用通用质量报告。 */
export function buildActiveAnalysisReport(): AnalysisReportPayload | undefined {
  switch (useApp.getState().page) {
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
export function buildActiveAnalysisExport(): { report?: AnalysisReportPayload; model: VarModel } {
  const app = useApp.getState();
  const data = useData.getState();
  let model = data.model;
  if ((app.page === 'spc' && app.spcType !== 'p' && app.spcType !== 'c') || app.page === 'capability') {
    const prepared = prepareSpcData(data.model, data.textCols, {
      layout: app.spcDataLayout,
      valueColumn: app.spcValueCol,
      subgroupColumn: app.spcSubgroupCol,
      pendingCells: data.pendingCells,
    });
    if (prepared.model && !prepared.error) model = prepared.model;
  }
  return { report: buildActiveAnalysisReport(), model };
}
