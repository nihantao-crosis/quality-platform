/**
 * Office 真渲染导出 — Word (.docx) 与 PowerPoint (.pptx),含图表位图。
 * builders 接受可选图片(测试环境无 canvas 时纯表格降级)。
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ImageRun, AlignmentType, BorderStyle,
} from 'docx';
import PptxGenJS from 'pptxgenjs';
import { renderToStaticMarkup } from 'react-dom/server';
import { nf, fmtCap, computeCapability, evalRules, DEFAULT_RULES, andersonDarling, type VarModel, assessCapability, countCapabilityViolations } from '../core';
import { chartTokens } from '../ui/tokens';
import { ControlChart } from '../ui/charts/ControlChart';
import { Histogram } from '../ui/charts/Histogram';
import { NormalProbPlot } from '../ui/charts/NormalProbPlot';
import type { ReportSpec } from './report';
import { svgMarkupToPng } from './svgToPng';
import { analysisUsesWorksheet, type AnalysisReportPayload, type AnalysisReportTable } from './analysisReportModel';

export interface ReportImages {
  xbar?: Uint8Array;
  hist?: Uint8Array;
  prob?: Uint8Array;
  /** 与 AnalysisReportPayload.charts 保持相同顺序。 */
  analysis?: Uint8Array[];
}

interface ReportStats {
  cap: ReturnType<typeof computeCapability>;
  viol: { i: number; rule: number; desc: string }[];
  adText: string;
}

function collectStats(M: VarModel, spec: ReportSpec): ReportStats {
  const cap = computeCapability(M.all, M.sigmaWithin, spec);
  const data = M.hasSubgroups ? M.subs.map((s) => s.mean) : M.indiv;
  const cl = M.hasSubgroups ? M.xbarbar : M.indMean;
  const sigma = M.hasSubgroups ? (M.uclX - M.xbarbar) / 3 : M.iSig;
  const { list: viol } = evalRules(data, cl, sigma, DEFAULT_RULES);
  let adText = '样本量不足,未执行正态性检验';
  if (M.all.length >= 8) {
    const ad = andersonDarling(M.all);
    adText = `Anderson-Darling A²* = ${nf(ad.a2star, 3)}, P ${ad.p < 0.005 ? '< 0.005' : '= ' + nf(ad.p, 3)} → ${ad.normal ? '未拒绝正态假设' : '显著偏离正态,建议 Box-Cox'}`;
  }
  return { cap, viol, adText };
}

/** 浏览器路径：渲染三张图为 PNG（经典主题,与界面一致） */
export async function renderReportImages(
  M: VarModel,
  spec: ReportSpec,
  analysis?: AnalysisReportPayload,
): Promise<ReportImages> {
  if (analysis) {
    return {
      analysis: await Promise.all(analysis.charts.map((chart) =>
        svgMarkupToPng(chart.svg, chart.width, chart.height, 2))),
    };
  }
  const T = chartTokens('经典', true);
  const spc = M.hasSubgroups
    ? { data: M.subs.map((s) => s.mean), cl: M.xbarbar, ucl: M.uclX, lcl: M.lclX, sigma: (M.uclX - M.xbarbar) / 3, label: 'X̄' }
    : { data: M.indiv, cl: M.indMean, ucl: M.iUcl, lcl: M.iLcl, sigma: M.iSig, label: 'I' };
  const { viol } = evalRules(spc.data, spc.cl, spc.sigma, DEFAULT_RULES);
  const mk = (el: React.ReactElement, w: number, h: number) =>
    svgMarkupToPng(renderToStaticMarkup(el), w, h, 2);
  return {
    xbar: await mk(
      <ControlChart T={T} data={spc.data} cl={spc.cl} ucl={spc.ucl} lcl={spc.lcl} clLabel={spc.label} h={250} zones violations={viol} />,
      960, 250,
    ),
    hist: await mk(
      <Histogram T={T} data={M.all} mu={M.oMean} sigmaWithin={M.sigmaWithin} sigmaOverall={M.oSd} lsl={spec.lsl} usl={spec.usl} tgt={spec.tgt} h={300} />,
      960, 300,
    ),
    prob: await mk(<NormalProbPlot T={T} data={M.all} h={280} />, 960, 280),
  };
}

const capPairs = (cap: ReportStats['cap']): Array<[string, string]> => [
  ['Cp', fmtCap(cap.cp)], ['Cpk', nf(cap.cpk, 2)], ['Pp', fmtCap(cap.pp)], ['Ppk', nf(cap.ppk, 2)],
  ['Cpm', fmtCap(cap.cpm)], ['CPU', fmtCap(cap.cpu)], ['CPL', fmtCap(cap.cpl)],
  ['Z.bench', nf(cap.zBench, 2)], ['σ 水平', nf(cap.sigmaLevel, 2)],
  ['PPM(整体)', String(Math.round(cap.ppm.overall.total))],
];

// P0-4:判定消费唯一判定器,失控时不得写无警示的「能力充足」。
const capabilityVerdictText = (M: VarModel, cap: ReportStats['cap']) => {
  const ad = M.all.length >= 8 ? andersonDarling(M.all) : null;
  const a = assessCapability({
    cpk: cap.cpk, verdict: cap.verdict, adP: ad ? ad.p : null, n: M.all.length,
    spcViolations: countCapabilityViolations(M, DEFAULT_RULES),
  });
  return a.spcViolations > 0 ? `${a.status}（${a.headline}）` : a.status;
};

// ============================== Word ==============================

export async function buildDocx(
  M: VarModel,
  spec: ReportSpec,
  images: ReportImages = {},
  analysis?: AnalysisReportPayload,
): Promise<Uint8Array> {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'E2E5EA' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (text: string, bold = false) =>
    new TableCell({
      borders,
      children: [new Paragraph({ children: [new TextRun({ text, bold, size: 19, font: 'IBM Plex Sans' })] })],
    });
  const kvTable = (pairs: Array<[string, string]>) =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: pairs.map(([k]) => cell(k, true)) }),
        new TableRow({ children: pairs.map(([, v]) => cell(v)) }),
      ],
    });
  const h = (text: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text, size: 26 })], spacing: { before: 240, after: 120 } });
  const p = (text: string) => new Paragraph({ children: [new TextRun({ text, size: 20 })], spacing: { after: 100 } });
  const img = (data?: Uint8Array, w = 620, hpx = 165) =>
    data
      ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data, transformation: { width: w, height: hpx } })] })]
      : [];

  const detailTable = (table: AnalysisReportTable) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: table.headers.map((header) => cell(header, true)) }),
      ...table.rows.map((row) => new TableRow({ children: row.map((value) => cell(String(value))) })),
    ],
  });

  if (analysis) {
    const sourceContext = analysisUsesWorksheet(analysis) ? ` · 工作表 ${M.name}` : '';
    const children: (Paragraph | Table)[] = [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: analysis.title, size: 40, bold: true })] }),
      p(`${analysis.subtitle}${sourceContext} · 生成于 ${analysis.generatedAt}`),
      h('1. 分析结论'),
      ...analysis.summary.map((line) => p(line)),
      ...analysis.warnings.flatMap((line, index) => index === 0 ? [h('使用与解释注意事项'), p(line)] : [p(line)]),
    ];
    analysis.tables.forEach((table, index) => {
      children.push(h(`${index + 2}. ${table.title}`), detailTable(table));
      if (table.note) children.push(p(table.note));
    });
    const chartBase = analysis.tables.length + 2;
    analysis.charts.forEach((chart, index) => {
      children.push(h(`${chartBase + index}. ${chart.title}`));
      children.push(...img(images.analysis?.[index], 620, Math.max(120, Math.round(620 * chart.height / chart.width))));
      if (chart.note) children.push(p(chart.note));
    });
    children.push(p('—— 本报告由质量分析平台根据当前分析参数实时生成 ——'));
    const doc = new Document({ sections: [{ children }] });
    const blob = await Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
  }

  const { cap, viol, adText } = collectStats(M, spec);

  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: '质量分析报告', size: 40, bold: true })] }),
    p(`工作表 ${M.name} · ${M.k} 子组 × ${M.n} 测量 = ${M.all.length} 观测 · 生成于 ${new Date().toLocaleString('zh-CN')}`),
    h('1. 过程概览'),
    kvTable([
      ['均值', nf(M.oMean, 4)], ['σ 组内', nf(M.sigmaWithin, 4)], ['σ 整体', nf(M.oSd, 4)],
      ['规格', `${nf(spec.lsl, 2)} / ${nf(spec.tgt, 2)} / ${nf(spec.usl, 2)}`], ['判定', `${capabilityVerdictText(M, cap)} (Cpk ${nf(cap.cpk, 2)})`],
    ]),
    h('2. SPC 控制图与判异'),
    ...img(images.xbar),
    p(viol.length === 0 ? '未检出失控点，过程受控（当前启用的 Nelson 准则）。' : `检出 ${viol.length} 项失控：` + viol.map((v) => `点${v.i + 1}(准则${v.rule})`).join('、')),
    h('3. 过程能力'),
    ...img(images.hist, 620, 194),
    kvTable(capPairs(cap)),
    h('4. 正态性检验'),
    ...img(images.prob, 620, 181),
    p(adText),
    p('—— 本报告由质量分析平台自动生成,所有统计量实时计算 ——'),
  ];

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

// ============================== PowerPoint ==============================

export async function buildPptx(
  M: VarModel,
  spec: ReportSpec,
  images: ReportImages = {},
  analysis?: AnalysisReportPayload,
): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE';
  const BLUE = '1F6FB2';
  const DARK = '26303C';
  const GRAY = '8A929D';

  const titleBar = (s: PptxGenJS.Slide, text: string) => {
    s.addShape('rect', { x: 0, y: 0, w: 13.33, h: 0.7, fill: { color: BLUE } });
    s.addText(text, { x: 0.4, y: 0.05, w: 12.5, h: 0.6, color: 'FFFFFF', bold: true, fontSize: 20 });
  };
  const chartSlide = (title: string, data: Uint8Array | undefined, ratio: number, note?: string) => {
    const s = pptx.addSlide();
    titleBar(s, title);
    if (data) {
      const b64 = 'data:image/png;base64,' + btoaBytes(data);
      const w = 11.5;
      const h = Math.min(5.4, w * ratio);
      s.addImage({ data: b64, x: (13.33 - w) / 2, y: 1.1, w, h });
    } else {
      s.addText('（图表在浏览器/桌面导出时嵌入）', { x: 0.9, y: 3, w: 11.5, h: 1, color: GRAY, fontSize: 16, align: 'center' });
    }
    if (note) s.addText(note, { x: 0.9, y: 6.7, w: 11.5, h: 0.5, color: GRAY, fontSize: 12 });
    return s;
  };

  if (analysis) {
    const sourceContext = analysisUsesWorksheet(analysis) ? ` · 工作表 ${M.name}` : '';
    const cover = pptx.addSlide();
    cover.addShape('rect', { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: 'F4F6F8' } });
    cover.addShape('rect', { x: 0, y: 3.0, w: 13.33, h: 0.06, fill: { color: BLUE } });
    cover.addText(analysis.title, { x: 1, y: 1.55, w: 11.3, h: 1.35, fontSize: 38, bold: true, color: DARK, fit: 'shrink' });
    cover.addText(`${analysis.subtitle}${sourceContext}`, { x: 1, y: 3.3, w: 11.3, h: 0.65, fontSize: 18, color: GRAY, fit: 'shrink' });
    cover.addText(`${analysis.generatedAt} · 质量分析平台`, { x: 1, y: 4.05, w: 11.3, h: 0.5, fontSize: 14, color: GRAY });

    const summarySlide = pptx.addSlide();
    titleBar(summarySlide, '分析结论');
    summarySlide.addText(analysis.summary.map((line) => ({ text: line, options: { bullet: { indent: 18 } } })), {
      x: 0.8, y: 1.0, w: 11.8, h: analysis.warnings.length ? 2.5 : 5.6, fontSize: 17, color: DARK, breakLine: true,
      valign: 'top', margin: 0.08, fit: 'shrink',
    });
    if (analysis.warnings.length > 0) {
      summarySlide.addShape('rect', { x: 0.8, y: 4.0, w: 11.8, h: 0.06, fill: { color: 'D98324' } });
      summarySlide.addText('使用与解释注意事项', { x: 0.8, y: 4.15, w: 11.8, h: 0.4, fontSize: 15, bold: true, color: 'B0620F' });
      summarySlide.addText(analysis.warnings.map((line) => ({ text: line, options: { bullet: { indent: 18 } } })), {
        x: 0.8, y: 4.6, w: 11.8, h: 2.1, fontSize: 13, color: GRAY, breakLine: true,
        valign: 'top', margin: 0.08, fit: 'shrink',
      });
    }

    for (const table of analysis.tables) {
      const chunks: Array<typeof table.rows> = [];
      for (let start = 0; start < table.rows.length; start += 14) chunks.push(table.rows.slice(start, start + 14));
      if (chunks.length === 0) chunks.push([]);
      chunks.forEach((chunk, chunkIndex) => {
        const slide = pptx.addSlide();
        titleBar(slide, `${table.title}${chunks.length > 1 ? ` (${chunkIndex + 1}/${chunks.length})` : ''}`);
        const rows: PptxGenJS.TableRow[] = [
          table.headers.map((header) => ({ text: header, options: { bold: true, color: DARK } })),
          ...chunk.map((row) => row.map((value) => ({ text: String(value) }))),
        ];
        slide.addTable(rows, {
          x: 0.55, y: 1.0, w: 12.2, h: 5.8, fontSize: 11,
          border: { type: 'solid', color: 'E2E5EA', pt: 1 },
          fill: { color: 'FFFFFF' }, margin: 0.05,
        });
        if (table.note) slide.addText(table.note, { x: 0.65, y: 6.95, w: 12, h: 0.3, fontSize: 9, color: GRAY, fit: 'shrink' });
      });
    }
    analysis.charts.forEach((chart, index) =>
      chartSlide(chart.title, images.analysis?.[index], chart.height / chart.width, chart.note));

    const buf = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
    return new Uint8Array(buf);
  }

  const { cap, viol, adText } = collectStats(M, spec);

  // 封面
  const cover = pptx.addSlide();
  cover.addShape('rect', { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: 'F4F6F8' } });
  cover.addShape('rect', { x: 0, y: 3.0, w: 13.33, h: 0.06, fill: { color: BLUE } });
  cover.addText('质量分析报告', { x: 1, y: 1.7, w: 11.3, h: 1.1, fontSize: 44, bold: true, color: DARK });
  cover.addText(`${M.name} · ${M.k} 子组 × ${M.n} 测量 = ${M.all.length} 观测`, { x: 1, y: 3.3, w: 11.3, h: 0.6, fontSize: 18, color: GRAY });
  cover.addText(`${new Date().toLocaleDateString('zh-CN')} · 质量分析平台`, { x: 1, y: 3.9, w: 11.3, h: 0.5, fontSize: 14, color: GRAY });

  // 概览 + 能力表
  const s2 = pptx.addSlide();
  titleBar(s2, '过程概览与能力指标');
  const rows: PptxGenJS.TableRow[] = [
    [
      { text: '均值', options: { bold: true } }, { text: 'σ 组内', options: { bold: true } },
      { text: 'σ 整体', options: { bold: true } }, { text: '规格 L/T/U', options: { bold: true } }, { text: '判定', options: { bold: true } },
    ],
    [nf(M.oMean, 4), nf(M.sigmaWithin, 4), nf(M.oSd, 4), `${nf(spec.lsl, 2)} / ${nf(spec.tgt, 2)} / ${nf(spec.usl, 2)}`, `${capabilityVerdictText(M, cap)} (Cpk ${nf(cap.cpk, 2)})`].map((t) => ({ text: t })),
  ];
  s2.addTable(rows, { x: 0.6, y: 1.1, w: 12.1, fontSize: 14, border: { type: 'solid', color: 'E2E5EA', pt: 1 }, fill: { color: 'FFFFFF' } });
  const capRows: PptxGenJS.TableRow[] = [
    capPairs(cap).map(([k]) => ({ text: k, options: { bold: true } })),
    capPairs(cap).map(([, v]) => ({ text: v })),
  ];
  s2.addTable(capRows, { x: 0.6, y: 2.6, w: 12.1, fontSize: 14, border: { type: 'solid', color: 'E2E5EA', pt: 1 } });
  s2.addText(adText, { x: 0.6, y: 4.3, w: 12.1, h: 0.5, fontSize: 13, color: GRAY });

  chartSlide(`SPC 控制图（${M.hasSubgroups ? 'X̄' : 'I'}）`, images.xbar, 250 / 960,
    viol.length === 0 ? '未检出失控点，过程受控' : `检出 ${viol.length} 项失控：` + viol.slice(0, 8).map((v) => `点${v.i + 1}(准则${v.rule})`).join('、'));
  chartSlide('过程能力直方图', images.hist, 300 / 960);
  chartSlide('正态概率图', images.prob, 280 / 960, adText);

  const buf = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
  return new Uint8Array(buf);
}

function btoaBytes(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  // btoa 在浏览器/WebView 可用;node 测试路径用 Buffer
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
}
