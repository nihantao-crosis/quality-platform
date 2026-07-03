/**
 * 图文报告 — 自包含 HTML（内嵌 SVG 图表 + 统计表），打开后浏览器打印即得 PDF。
 * 图表经 renderToStaticMarkup 复用应用内组件,与界面所见一致（经典主题）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import {
  nf, computeCapability, evalRules, andersonDarling, type VarModel,
} from '../core';
import { chartTokens } from '../ui/tokens';
import { ControlChart } from '../ui/charts/ControlChart';
import { Histogram } from '../ui/charts/Histogram';
import { NormalProbPlot } from '../ui/charts/NormalProbPlot';
import type { ReportSpec } from './report';

const CSS = `
  body { font-family: "IBM Plex Sans", "PingFang SC", "Microsoft YaHei", sans-serif; color: #2a333f; margin: 0; padding: 32px 40px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #8a929d; font-size: 12.5px; margin-bottom: 24px; }
  h2 { font-size: 15px; margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #1f6fb2; color: #26303c; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin: 8px 0; }
  th, td { border: 1px solid #e2e5ea; padding: 6px 10px; text-align: left; }
  th { background: #f4f6f8; color: #5b6472; font-weight: 600; }
  td.num { text-align: right; font-family: "IBM Plex Mono", monospace; }
  .verdict-ok { color: #2c8a45; font-weight: 700; }
  .verdict-warn { color: #d98324; font-weight: 700; }
  .verdict-bad { color: #c22f2f; font-weight: 700; }
  .chart { margin: 10px 0 18px; border: 1px solid #eef0f3; border-radius: 4px; }
  .footer { margin-top: 30px; color: #9aa2ad; font-size: 11px; border-top: 1px solid #eef0f3; padding-top: 10px; }
  @media print { body { padding: 0; } .chart { break-inside: avoid; } h2 { break-after: avoid; } }
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildHtmlReport(M: VarModel, spec: ReportSpec): string {
  const T = chartTokens('经典', true);
  const cap = computeCapability(M.all, M.sigmaWithin, spec);
  const means = M.subs.map((s) => s.mean);
  const sig = (M.uclX - M.xbarbar) / 3;
  const { list: viol } = evalRules(means, M.xbarbar, sig, { r1: true, r2: true, r3: true, r4: true });
  const ad = M.all.length >= 8 ? andersonDarling(M.all) : null;

  const xbarSvg = renderToStaticMarkup(
    <ControlChart T={T} data={means} cl={M.xbarbar} ucl={M.uclX} lcl={M.lclX} clLabel="X̄" h={250} zones violations={new Set(viol.map((v) => v.i))} />,
  );
  const histSvg = renderToStaticMarkup(
    <Histogram T={T} data={M.all} mu={M.oMean} sigmaWithin={M.sigmaWithin} sigmaOverall={M.oSd} lsl={spec.lsl} usl={spec.usl} tgt={spec.tgt} h={300} />,
  );
  const probSvg = renderToStaticMarkup(<NormalProbPlot T={T} data={M.all} h={280} />);

  const verdictCls = cap.verdict === 'sufficient' ? 'verdict-ok' : cap.verdict === 'marginal' ? 'verdict-warn' : 'verdict-bad';
  const verdictTxt = cap.verdict === 'sufficient' ? '能力充足' : cap.verdict === 'marginal' ? '能力临界' : '能力不足';

  const capRows: Array<[string, string]> = [
    ['Cp', nf(cap.cp, 2)], ['Cpk', nf(cap.cpk, 2)], ['Pp', nf(cap.pp, 2)], ['Ppk', nf(cap.ppk, 2)],
    ['Cpm (望目)', nf(cap.cpm, 2)], ['CPU', nf(cap.cpu, 2)], ['CPL', nf(cap.cpl, 2)],
    ['Z.bench', nf(cap.zBench, 2)], ['西格玛水平', nf(cap.sigmaLevel, 2) + 'σ'],
    ['PPM 合计（整体）', Math.round(cap.ppm.overall.total).toLocaleString()],
  ];

  const violHtml = viol.length === 0
    ? '<p class="verdict-ok">✓ 未检出失控点，过程受控（Nelson 准则 1–4）</p>'
    : `<table><tr><th>点号</th><th>准则</th><th>描述</th></tr>${viol
        .map((v) => `<tr><td class="num">${v.i + 1}</td><td class="num">${v.rule}</td><td>${esc(v.desc)}</td></tr>`)
        .join('')}</table>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>质量分析报告 · ${esc(M.name)}</title>
<style>${CSS}</style>
</head>
<body>
<h1>质量分析报告</h1>
<div class="sub">工作表 ${esc(M.name)} · ${M.k} 子组 × ${M.n} 测量 = ${M.all.length} 观测 · 生成于 ${new Date().toLocaleString('zh-CN')} · 质量分析平台</div>

<h2>1. 过程概览</h2>
<table>
  <tr><th>均值</th><th>σ 组内 (R̄/d₂)</th><th>σ 整体</th><th>规格 LSL / 目标 / USL</th><th>能力判定</th></tr>
  <tr>
    <td class="num">${nf(M.oMean, 4)}</td>
    <td class="num">${nf(M.sigmaWithin, 4)}</td>
    <td class="num">${nf(M.oSd, 4)}</td>
    <td class="num">${nf(spec.lsl, 2)} / ${nf(spec.tgt, 2)} / ${nf(spec.usl, 2)}</td>
    <td><span class="${verdictCls}">${verdictTxt}</span>（Cpk ${nf(cap.cpk, 2)}）</td>
  </tr>
</table>

<h2>2. SPC 控制图（X̄）与判异</h2>
<div class="chart">${xbarSvg}</div>
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
  ? `<p>Anderson-Darling：A²* = ${nf(ad.a2star, 3)}，P ${ad.p < 0.005 ? '&lt; 0.005' : '= ' + nf(ad.p, 3)} → <span class="${ad.normal ? 'verdict-ok' : 'verdict-bad'}">${ad.normal ? '服从正态分布,能力指标可直接使用' : '显著偏离正态,建议 Box-Cox 变换后评估能力'}</span></p>`
  : '<p>样本量不足（N &lt; 8），未执行检验。</p>'}

<div class="footer">本报告由质量分析平台自动生成 · 所有统计量实时计算 · 打印本页（⌘/Ctrl+P）即可保存为 PDF</div>
</body>
</html>`;
}
