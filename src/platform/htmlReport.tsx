/**
 * 图文报告 — 自包含 HTML（内嵌 SVG 图表 + 统计表），打开后浏览器打印即得 PDF。
 * 图表经 renderToStaticMarkup 复用应用内组件,与界面所见一致（经典主题）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import {
  nf, fmtCap, computeCapability, capabilityInputError, evaluateAndersonDarling, type VarModel, type SpcAssessment,
  assessCapability, } from '../core';
import { chartTokens } from '../ui/tokens';
import { ControlChart } from '../ui/charts/ControlChart';
import { Histogram } from '../ui/charts/Histogram';
import { NormalProbPlot } from '../ui/charts/NormalProbPlot';
import type { ReportSpec } from './report';
import { analysisUsesWorksheet, type AnalysisReportPayload } from './analysisReportModel';
import { reportContextText, reportSpecText, withinSigmaLabel, MAX_HTML_VIOLATION_ROWS, violationTruncationNote } from './reportLabels';

const CSS = `
  body { font-family: "IBM Plex Sans", "PingFang SC", "Microsoft YaHei", sans-serif; color: #2a333f; margin: 0; padding: 32px 40px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #8a929d; font-size: 12.5px; margin-bottom: 24px; }
  h2 { font-size: 15px; margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #1f6fb2; color: #26303c; }
  h3 { font-size: 13px; margin: 16px 0 8px; color: #4a5563; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin: 8px 0; }
  th, td { border: 1px solid #e2e5ea; padding: 6px 10px; text-align: left; }
  th { background: #f4f6f8; color: #5b6472; font-weight: 600; }
  td.num { text-align: right; font-family: "IBM Plex Mono", monospace; }
  .verdict-ok { color: #2c8a45; font-weight: 700; }
  .verdict-warn { color: #d98324; font-weight: 700; }
  .verdict-bad { color: #c22f2f; font-weight: 700; }
  .summary { background: #f4f8fc; border-left: 4px solid #1f6fb2; padding: 10px 14px; margin: 10px 0 16px; }
  .summary p, .warning p { margin: 4px 0; line-height: 1.55; }
  .warning { background: #fff8e8; border-left: 4px solid #d98324; padding: 10px 14px; margin: 10px 0 16px; }
  .chart { margin: 10px 0 18px; border: 1px solid #eef0f3; border-radius: 4px; }
  .footer { margin-top: 30px; color: #9aa2ad; font-size: 11px; border-top: 1px solid #eef0f3; padding-top: 10px; }
  @media print { body { padding: 0; } .chart { break-inside: avoid; } h2 { break-after: avoid; } }
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildAnalysisHtml(M: VarModel, analysis: AnalysisReportPayload): string {
  const sourceContext = analysisUsesWorksheet(analysis) ? ` · 工作表 ${esc(M.name)}` : '';
  const summary = `<div class="summary">${analysis.summary.map((line) => `<p>${esc(line)}</p>`).join('')}</div>`;
  const warnings = analysis.warnings.length
    ? `<div class="warning"><b>使用与解释注意事项</b>${analysis.warnings.map((line) => `<p>${esc(line)}</p>`).join('')}</div>`
    : '';
  const tables = analysis.tables.map((table, index) => `
    <h2>${index + 2}. ${esc(table.title)}</h2>
    <table>
      <tr>${table.headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr>
      ${table.rows.map((row) => `<tr>${row.map((value) => `<td>${esc(String(value))}</td>`).join('')}</tr>`).join('')}
    </table>
    ${table.note ? `<p class="sub">${esc(table.note)}</p>` : ''}
  `).join('');
  const chartBase = analysis.tables.length + 2;
  const charts = analysis.charts.map((chart, index) => `
    <h2>${chartBase + index}. ${esc(chart.title)}</h2>
    <div class="chart">${chart.svg}</div>
    ${chart.note ? `<p>${esc(chart.note)}</p>` : ''}
  `).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${esc(analysis.title)}</title><style>${CSS}</style></head>
<body>
<h1>${esc(analysis.title)}</h1>
<div class="sub">${esc(analysis.subtitle)}${sourceContext} · 生成于 ${esc(analysis.generatedAt)} · 质量分析平台</div>
<h2>1. 分析结论</h2>
${summary}
${warnings}
${tables}
${charts}
<div class="footer">本报告由质量分析平台根据当前分析参数实时生成 · 打印本页（⌘/Ctrl+P）即可保存为 PDF</div>
</body></html>`;
}

export function buildHtmlReport(
  M: VarModel,
  spec: ReportSpec,
  assessment: SpcAssessment | null,
  analysis?: AnalysisReportPayload,
  capabilityModel: VarModel = M,
  capabilitySpcViolations?: number | null,
): string {
  // 专项分析自带表格/图形，按原有专项载荷直接导出；下方双 SPC 图只属于通用质量报告。
  if (analysis) return buildAnalysisHtml(M, analysis);
  if (!assessment) throw new Error('通用 HTML 报告缺少 SPC 判异结果');
  const C = capabilityModel;
  const capSpcCount = capabilitySpcViolations ?? assessment.chartPointCount;
  const T = chartTokens('经典', true);
  // 能力输入闸门:规格与数据量纲不匹配(1000σ 哨兵)等情况写「未运行」,其余章节照常导出
  const capError = capabilityInputError(C.all, C.sigmaWithin, spec);
  const cap = capError ? null : computeCapability(C.all, C.sigmaWithin, spec);
  const spc = M.hasSubgroups
    ? { data: M.subs.map((s) => s.mean), cl: M.xbarbar, ucl: M.uclX, lcl: M.lclX, label: 'X̄' }
    : { data: M.indiv, cl: M.indMean, ucl: M.iUcl, lcl: M.iLcl, label: 'I' };
  const dispersion = M.hasSubgroups
    ? { data: M.subs.map((s) => s.range), cl: M.rCl, ucl: M.uclR, lcl: M.lclR, label: 'R', clLabel: 'R̄', xIndexOffset: 0 }
    : { data: M.mr.slice(1) as number[], cl: M.mrbar, ucl: M.mrUcl, lcl: 0, label: 'MR', clLabel: 'MR̄', xIndexOffset: 1 };
  const adEvaluation = evaluateAndersonDarling(C.all);
  const ad = adEvaluation.result;

  const xbarSvg = renderToStaticMarkup(
    <ControlChart T={T} data={spc.data} cl={spc.cl} ucl={spc.ucl} lcl={spc.lcl} clLabel={spc.label} h={250} zones violations={assessment.locationViolIndexes} />,
  );
  const dispersionSvg = renderToStaticMarkup(
    <ControlChart
      T={T}
      data={dispersion.data}
      cl={dispersion.cl}
      ucl={dispersion.ucl}
      lcl={dispersion.lcl}
      clLabel={dispersion.clLabel}
      h={250}
      zones
      violations={assessment.dispersionViolIndexes}
      xIndexOffset={dispersion.xIndexOffset}
    />,
  );
  const histSvg = renderToStaticMarkup(
    <Histogram T={T} data={C.all} mu={C.oMean} sigmaWithin={C.sigmaWithin} sigmaOverall={C.oSd} lsl={spec.lsl} usl={spec.usl} tgt={spec.tgt} h={300} />,
  );
  const probSvg = renderToStaticMarkup(<NormalProbPlot T={T} data={C.all} h={280} />);

  // P0-4:判定消费唯一判定器(含位置+离散图稳定性与正态性),失控时不得绿色「能力充足」。
  const capAssessment = cap ? assessCapability({
    cpk: cap.cpk, verdict: cap.verdict, adP: ad ? ad.p : null, n: C.all.length,
    spcViolations: capSpcCount,
  }) : null;
  const verdictCls = !capAssessment ? 'verdict-warn' : capAssessment.level === 'ok' ? 'verdict-ok' : capAssessment.level === 'warn' ? 'verdict-warn' : 'verdict-bad';
  const verdictTxt = capAssessment ? capAssessment.status : '能力分析未运行';

  const capRows: Array<[string, string]> = cap ? [
    ['Cp', fmtCap(cap.cp)], ['Cpk', nf(cap.cpk, 2)], ['Pp', fmtCap(cap.pp)], ['Ppk', nf(cap.ppk, 2)],
    ['Cpm (望目)', fmtCap(cap.cpm)], ['CPU', fmtCap(cap.cpu)], ['CPL', fmtCap(cap.cpl)],
    ['Z.bench', nf(cap.zBench, 2)], ['西格玛水平', nf(cap.sigmaLevel, 2) + 'σ'],
    ['PPM 合计（整体）', Math.round(cap.ppm.overall.total).toLocaleString()],
  ] : [
    ['能力分析未运行', capError ?? ''],
  ];

  // 位置图+离散图统一判异明细(v1.42.3):结论行与明细同源,离散图失控不再与「受控」并存
  const countSummary = `各图累计 ${assessment.chartPointCount} 个失控点（${assessment.locationLabel} 图 ${assessment.locationPoints} 个 + ${assessment.dispersionLabel} 图 ${assessment.dispersionPoints} 个）；去重${assessment.analysisUnitLabel} ${assessment.uniqueAnalysisUnitCount} 个`;
  const violHtml = assessment.events.length === 0
    ? `<p class="verdict-ok">${esc(assessment.verdictLine)}</p>`
    : `<p class="verdict-bad">${esc(assessment.verdictLine)}（${esc(countSummary)}）</p>`
      + `<table><tr><th>点号</th><th>图</th><th>准则</th><th>描述</th></tr>${assessment.events
        // 行数硬上限(v1.42.4):对抗性数据可产出 50 万+事件,完整渲染会冻结浏览器;截断行写明总数
        .slice(0, MAX_HTML_VIOLATION_ROWS)
        .map((v) => `<tr><td class="num">${v.i + 1}</td><td>${esc(v.chart)}</td><td class="num">${v.rule}</td><td>${esc(v.desc)}</td></tr>`)
        .join('')}${assessment.events.length > MAX_HTML_VIOLATION_ROWS
        ? `<tr><td colspan="4">${esc(violationTruncationNote(assessment.events.length, MAX_HTML_VIOLATION_ROWS))}</td></tr>`
        : ''}</table>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>质量分析报告 · ${esc(M.name)}</title>
<style>${CSS}</style>
</head>
<body>
<h1>质量分析报告</h1>
<div class="sub">工作表 ${esc(M.name)} · ${reportContextText(M, C)} · 生成于 ${new Date().toLocaleString('zh-CN')} · 质量分析平台</div>

<h2>1. 过程概览</h2>
<table>
  <tr><th>能力口径均值</th><th>${withinSigmaLabel(C)}</th><th>σ 整体</th><th>规格 LSL / 目标 / USL</th><th>能力判定</th></tr>
  <tr>
    <td class="num">${nf(C.oMean, 4)}</td>
    <td class="num">${nf(C.sigmaWithin, 4)}</td>
    <td class="num">${nf(C.oSd, 4)}</td>
    <td class="num">${reportSpecText(spec, 2)}</td>
    <td><span class="${verdictCls}">${verdictTxt}</span>${cap ? `（Cpk ${nf(cap.cpk, 2)}）` : ''}</td>
  </tr>
</table>

<h2>2. SPC 控制图（${spc.label}-${dispersion.label}）与判异</h2>
<h3>${spc.label} 控制图（位置）</h3>
<div class="chart">${xbarSvg}</div>
<h3>${dispersion.label} 控制图（离散）</h3>
<div class="chart">${dispersionSvg}</div>
${violHtml}

<h2>3. 过程能力</h2>
<div class="chart">${histSvg}</div>
<table>
  <tr>${capRows.map(([k]) => `<th>${k}</th>`).join('')}</tr>
  <tr>${capRows.map(([, v]) => `<td class="num">${v}</td>`).join('')}</tr>
</table>

<h2>4. 正态性检验</h2>
<div class="chart">${probSvg}</div>
${ad
  ? `<p>Anderson-Darling：A²* = ${nf(ad.a2star, 3)}，P ${ad.p < 0.005 ? '&lt; 0.005' : '= ' + nf(ad.p, 3)} → <span class="${ad.normal ? 'verdict-ok' : 'verdict-bad'}">${ad.normal ? '未拒绝正态假设(现有样本未发现显著偏离正态的证据),能力指标可使用' : '显著偏离正态,建议 Box-Cox 变换后评估能力'}</span></p>`
  : `<p>${esc(adEvaluation.unavailableReason ?? '正态性不可判定')}。</p>`}

<div class="footer">本报告由质量分析平台自动生成 · 所有统计量实时计算 · 打印本页（⌘/Ctrl+P）即可保存为 PDF</div>
</body>
</html>`;
}
