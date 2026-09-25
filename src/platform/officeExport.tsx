/* eslint-disable no-control-regex -- cleanXml/清洗逻辑的目标正是匹配并剥离控制字符 */
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
import { nf, fmtCap, computeCapability, capabilityInputError, evaluateAndersonDarling, type VarModel, type SpcAssessment, assessCapability } from '../core';
import { chartTokens } from '../ui/tokens';
import { ControlChart } from '../ui/charts/ControlChart';
import { Histogram } from '../ui/charts/Histogram';
import { NormalProbPlot } from '../ui/charts/NormalProbPlot';
import type { ReportSpec } from './report';
import { svgMarkupToPng } from './svgToPng';
import { analysisTableTotalRows, analysisUsesWorksheet, type AnalysisReportPayload, type AnalysisReportTable } from './analysisReportModel';
import { MAX_REPORT_TABLE_ROWS, MAX_XLSX_VIOLATION_ROWS, tableTruncationNote, timestampText, appVersionText, reportContextText, reportSpecText, reportNum, withinSigmaLabel, capabilityCaliberLine, stagedChartProps, type ReportCapabilityOptions } from './reportLabels';

/** OOXML 文本合法化(双审 P2):XML 1.0 禁止绝大多数控制字符,原样写入会产出
 * Word/PowerPoint 拒绝打开的损坏文件而界面仍提示导出成功。导入文本(粘贴/CSV)
 * 可能携带 \x00-\x1F 等字符,在唯一入口统一剥离。 */
const cleanXml = (text: string): string => text
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '')
  // 孤立代理对同属 XML 非法(成对代理是合法增补平面字符,必须保留)
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
  .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

export interface ReportImages {
  xbar?: Uint8Array;
  /** R / MR 离散图，与 xbar 位置图成对出现。 */
  dispersion?: Uint8Array;
  hist?: Uint8Array;
  prob?: Uint8Array;
  /** 与 AnalysisReportPayload.charts 保持相同顺序。 */
  analysis?: Uint8Array[];
}

interface ReportStats {
  /** 能力输入闸门未通过(如 1000σ 量纲哨兵)时为 null,capError 给出原因;其余章节照常导出。 */
  cap: ReturnType<typeof computeCapability> | null;
  capError: string | null;
  viol: { i: number; rule: number; desc: string; chart: string }[];
  verdictLine: string;
  /** 失控结论 + 三个计数各自标注口径(各图点数/去重分析单元数),与其余格式同一表述 */
  violSummary: string;
  adText: string;
  capabilityOverrideAcknowledged: boolean;
}

function collectStats(
  M: VarModel,
  spec: ReportSpec,
  assessment: SpcAssessment,
  capabilityOptions: ReportCapabilityOptions = {},
): ReportStats {
  const capError = capabilityInputError(M.all, M.sigmaWithin, spec, capabilityOptions);
  const cap = capError ? null : computeCapability(M.all, M.sigmaWithin, spec, capabilityOptions);
  // v1.42.3:位置+离散图统一判异明细,与判定行同源
  const viol = assessment.events;
  const adEvaluation = evaluateAndersonDarling(M.all);
  let adText = adEvaluation.unavailableReason ?? '正态性不可判定';
  if (adEvaluation.result) {
    const ad = adEvaluation.result;
    adText = `Anderson-Darling A²* = ${nf(ad.a2star, 3)}, P ${ad.p < 0.005 ? '< 0.005' : '= ' + nf(ad.p, 3)} → ${ad.normal ? '未拒绝正态假设' : '显著偏离正态,建议 Box-Cox'}`;
  }
  const violSummary = `${assessment.verdictLine}（各图累计 ${assessment.chartPointCount} 个失控点：${assessment.locationLabel} 图 ${assessment.locationPoints} 个 + ${assessment.dispersionLabel} 图 ${assessment.dispersionPoints} 个；去重${assessment.analysisUnitLabel} ${assessment.uniqueAnalysisUnitCount} 个）`;
  return {
    cap,
    capError,
    viol,
    verdictLine: assessment.verdictLine,
    violSummary,
    adText,
    capabilityOverrideAcknowledged: capabilityOptions.allowDistantSpec === true,
  };
}

/** Word/PPT 是阅读摘要；逐行完整明细保留在 HTML/文本/Excel，避免演示文档因长游程无限膨胀。 */
function officeViolationText(
  viol: ReportStats['viol'],
  verdictLine: string,
  violSummary: string,
  limit: number,
): string {
  if (viol.length === 0) return verdictLine;
  const shown = viol.slice(0, limit)
    .map((item) => `${item.chart}图点${item.i + 1}(准则${item.rule}：${item.desc})`)
    .join('、');
  const continuation = viol.length > MAX_XLSX_VIOLATION_ROWS
    ? `Excel 同样最多列前 ${MAX_XLSX_VIOLATION_ROWS} 项；如需完整明细，请缩小数据范围或减少启用的判异准则`
    : '完整明细请导出 Excel';
  return viol.length > limit
    ? `${violSummary}：${shown}（摘要仅列前 ${limit} 项；共 ${viol.length} 项，${continuation}）`
    : `${violSummary}：${shown}`;
}

/** PPT 每张控制图只列自己的点×准则明细，避免把 R/MR 异常挂在 X̄/I 图下。 */
function officeChartViolationText(
  viol: ReportStats['viol'],
  violSummary: string,
  chartLabel: string,
  limit: number,
): string {
  const chartViol = viol.filter((item) => item.chart === chartLabel);
  if (chartViol.length === 0) return `${violSummary}；${chartLabel} 图无逐点判异明细`;
  const shown = chartViol.slice(0, limit)
    .map((item) => `${item.chart}图点${item.i + 1}(准则${item.rule}：${item.desc})`)
    .join('、');
  const continuation = viol.length > MAX_XLSX_VIOLATION_ROWS
    ? `Excel 同样最多列前 ${MAX_XLSX_VIOLATION_ROWS} 项；如需完整明细，请缩小数据范围或减少启用的判异准则`
    : '完整明细请导出 Excel';
  return chartViol.length > limit
    ? `${violSummary}；${chartLabel} 图明细：${shown}（摘要仅列前 ${limit} 项；该图共 ${chartViol.length} 项，${continuation}）`
    : `${violSummary}；${chartLabel} 图明细：${shown}`;
}

/** 浏览器路径：渲染位置图、离散图、直方图和概率图为 PNG。 */
export async function renderReportImages(
  M: VarModel,
  spec: ReportSpec,
  assessment: SpcAssessment | null,
  analysis?: AnalysisReportPayload,
  capabilityModel: VarModel = M,
): Promise<ReportImages> {
  // 专项分析按自身 charts 原样输出，不混入通用报告的 SPC/能力图。
  if (analysis) {
    return {
      analysis: await Promise.all(analysis.charts.map((chart) =>
        svgMarkupToPng(chart.svg, chart.width, chart.height, 2))),
    };
  }
  if (!assessment) throw new Error('通用报告图片缺少 SPC 判异结果');
  const C = capabilityModel;
  const T = chartTokens('经典', true);
  const spc = assessment.location;
  const dispersion = assessment.dispersion;
  const mk = (el: React.ReactElement, w: number, h: number) =>
    svgMarkupToPng(renderToStaticMarkup(el), w, h, 2);
  return {
    xbar: await mk(
      <ControlChart
        T={T} data={spc.data} cl={spc.cl} ucl={spc.ucl} lcl={spc.lcl} clLabel={spc.clLabel} h={250} zones violations={assessment.locationViolIndexes}
        {...stagedChartProps(spc)}
      />,
      960, 250,
    ),
    dispersion: await mk(
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
        {...stagedChartProps(dispersion)}
      />,
      960, 250,
    ),
    hist: await mk(
      <Histogram T={T} data={C.all} mu={C.oMean} sigmaWithin={C.sigmaWithin} sigmaOverall={C.oSd} lsl={spec.lsl} usl={spec.usl} tgt={spec.tgt} h={300} />,
      960, 300,
    ),
    prob: await mk(<NormalProbPlot T={T} data={C.all} h={280} />, 960, 280),
  };
}

const capPairs = (cap: NonNullable<ReportStats['cap']>): Array<[string, string]> => [
  ['Cp', fmtCap(cap.cp)], ['Cpk', nf(cap.cpk, 2)], ['Pp', fmtCap(cap.pp)], ['Ppk', nf(cap.ppk, 2)],
  ['Cpm', fmtCap(cap.cpm)], ['CPU', fmtCap(cap.cpu)], ['CPL', fmtCap(cap.cpl)],
  ['Z.bench', nf(cap.zBench, 2)], ['σ 水平', nf(cap.sigmaLevel, 2)],
  ['PPM(整体)', String(Math.round(cap.ppm.overall.total))],
];

// P0-4:判定消费唯一判定器,失控时不得写无警示的「能力充足」。
const capabilityVerdictText = (M: VarModel, cap: NonNullable<ReportStats['cap']>, spcViolations: number) => {
  const ad = evaluateAndersonDarling(M.all).result;
  const a = assessCapability({
    cpk: cap.cpk, verdict: cap.verdict, adP: ad ? ad.p : null, n: M.all.length,
    spcViolations,
  });
  return a.spcViolations > 0 ? `${a.status}（${a.headline}）` : a.status;
};

// ============================== Word ==============================

export async function buildDocx(
  M: VarModel,
  spec: ReportSpec,
  images: ReportImages,
  assessment: SpcAssessment | null,
  analysis?: AnalysisReportPayload,
  capabilityModel: VarModel = M,
  capabilitySpcViolations?: number | null,
  capabilityOptions: ReportCapabilityOptions = {},
): Promise<Uint8Array> {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'E2E5EA' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (text: string, bold = false) =>
    new TableCell({
      borders,
      children: [new Paragraph({ children: [new TextRun({ text: cleanXml(text), bold, size: 19, font: 'IBM Plex Sans' })] })],
    });
  const kvTable = (pairs: Array<[string, string]>) =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: pairs.map(([k]) => cell(k, true)) }),
        new TableRow({ children: pairs.map(([, v]) => cell(v)) }),
      ],
    });
  const h = (text: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: cleanXml(text), size: 26 })], spacing: { before: 240, after: 120 } });
  const p = (text: string) => new Paragraph({ children: [new TextRun({ text: cleanXml(text), size: 20 })], spacing: { after: 100 } });
  // 位图缺失时插入显式占位说明(双审 P2/P3):此前 Word 静默产出「有小标题、没有图」的
  // 报告且提示导出成功;PPT 早有占位文案,Word 对齐同一口径
  const img = (data?: Uint8Array, w = 620, hpx = 165) =>
    data
      ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data, transformation: { width: w, height: hpx } })] })]
      : [p('（图表位图生成失败，本节仅含数据表；图形请改用「图文报告(HTML)」导出查看）')];

  // 第三轮 P1:Word 是阅读摘要,观测级大表全量 map 会在 13 万行抛 RangeError、
  // 4–8 万行冻结数秒;与 PPT 20 页/Excel 明细上限同一形制,截断并明示
  const MAX_WORD_TABLE_ROWS = MAX_REPORT_TABLE_ROWS;
  const detailTable = (table: AnalysisReportTable) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: table.headers.map((header) => cell(header, true)) }),
      ...table.rows.slice(0, MAX_WORD_TABLE_ROWS).map((row) => new TableRow({ children: row.map((value) => cell(String(value))) })),
    ],
  });
  const detailTableNote = (table: AnalysisReportTable) =>
    analysisTableTotalRows(table) > Math.min(table.rows.length, MAX_WORD_TABLE_ROWS)
      ? [p(tableTruncationNote(
          analysisTableTotalRows(table),
          Math.min(table.rows.length, MAX_WORD_TABLE_ROWS),
          'Word 摘要',
          analysisTableTotalRows(table) === table.rows.length,
        ))]
      : [];

  if (analysis) {
    const sourceContext = analysisUsesWorksheet(analysis) ? ` · 工作表 ${M.name}` : '';
    const children: (Paragraph | Table)[] = [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: cleanXml(analysis.title), size: 40, bold: true })] }),
      p(`${analysis.subtitle}${sourceContext} · 生成于 ${analysis.generatedAt} · v${appVersionText()}`),
      h('1. 分析结论'),
      ...analysis.summary.map((line) => p(line)),
      ...analysis.warnings.flatMap((line, index) => index === 0 ? [h('使用与解释注意事项'), p(line)] : [p(line)]),
    ];
    analysis.tables.forEach((table, index) => {
      children.push(h(`${index + 2}. ${table.title}`), detailTable(table), ...detailTableNote(table));
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
  if (!assessment) throw new Error('通用 Word 报告缺少 SPC 判异结果');

  const C = capabilityModel;
  const capSpcCount = capabilitySpcViolations ?? assessment.chartPointCount;
  const { cap, capError, viol, verdictLine, violSummary, adText, capabilityOverrideAcknowledged } = collectStats(C, spec, assessment, capabilityOptions);
  const docxCaliberLine = capabilityCaliberLine(capabilityOptions, capSpcCount);

  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: cleanXml('质量分析报告'), size: 40, bold: true })] }),
    p(`工作表 ${M.name} · ${reportContextText(M, C)} · 生成于 ${timestampText()} · v${appVersionText()}`),
    h('1. 过程概览'),
    kvTable([
      ['能力口径均值', reportNum(C.oMean, 4)], [withinSigmaLabel(C), reportNum(C.sigmaWithin, 4)], ['σ 整体', reportNum(C.oSd, 4)],
      ['规格', reportSpecText(spec)], ['判定', cap ? `${capabilityVerdictText(C, cap, capSpcCount)} (Cpk ${nf(cap.cpk, 2)})` : '能力分析未运行'],
    ]),
    h(`2. SPC 控制图（${assessment.locationLabel}-${assessment.dispersionLabel}）与判异`),
    p(`${assessment.locationLabel} 控制图（位置）`),
    ...img(images.xbar),
    p(`${assessment.dispersionLabel} 控制图（离散）`),
    ...img(images.dispersion),
    p(officeViolationText(viol, verdictLine, violSummary, 12)),
    h('3. 过程能力'),
    ...(capabilityOverrideAcknowledged ? [p('⚠ 用户已核对当前测量角色与规格，并显式确认继续计算远距离规格。')] : []),
    ...(docxCaliberLine ? [p(docxCaliberLine)] : []),
    ...img(images.hist, 620, 194),
    cap ? kvTable(capPairs(cap)) : p(`能力分析未运行: ${capError}`),
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
  images: ReportImages,
  assessment: SpcAssessment | null,
  analysis?: AnalysisReportPayload,
  capabilityModel: VarModel = M,
  capabilitySpcViolations?: number | null,
  capabilityOptions: ReportCapabilityOptions = {},
): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE';
  const BLUE = '1F6FB2';
  const DARK = '26303C';
  const GRAY = '8A929D';

  const titleBar = (s: PptxGenJS.Slide, text: string) => {
    s.addShape('rect', { x: 0, y: 0, w: 13.33, h: 0.7, fill: { color: BLUE } });
    s.addText(cleanXml(String(text)), { x: 0.4, y: 0.05, w: 12.5, h: 0.6, color: 'FFFFFF', bold: true, fontSize: 20 });
  };
  const chartSlide = (title: string, data: Uint8Array | undefined, ratio: number, note?: string) => {
    const s = pptx.addSlide();
    titleBar(s, title);
    let imageBottom = 4.1;
    if (data) {
      const b64 = 'data:image/png;base64,' + btoaBytes(data);
      // 等比缩放(双审 P2):高度钳到 5.4 时宽度必须同步收缩,否则横向拉伸(实测 MSA 报告 1.9×)
      let w = 11.5;
      let h = w * ratio;
      if (h > 5.4) { h = 5.4; w = h / ratio; }
      s.addImage({ data: b64, x: (13.33 - w) / 2, y: 1.1, w, h });
      imageBottom = 1.1 + h;
    } else {
      s.addText('（图表在浏览器/桌面导出时嵌入）', { x: 0.9, y: 3, w: 11.5, h: 1, color: GRAY, fontSize: 16, align: 'center' });
    }
    if (note) {
      const noteY = Math.min(6.55, imageBottom + 0.15);
      s.addText(cleanXml(String(note)), {
        x: 0.9, y: noteY, w: 11.5, h: Math.max(0.55, 7.25 - noteY),
        color: GRAY, fontSize: 11, fit: 'shrink', valign: 'top', margin: 0.03,
      });
    }
    return s;
  };

  if (analysis) {
    const sourceContext = analysisUsesWorksheet(analysis) ? ` · 工作表 ${M.name}` : '';
    const cover = pptx.addSlide();
    cover.addShape('rect', { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: 'F4F6F8' } });
    cover.addShape('rect', { x: 0, y: 3.0, w: 13.33, h: 0.06, fill: { color: BLUE } });
    cover.addText(cleanXml(String(analysis.title)), { x: 1, y: 1.55, w: 11.3, h: 1.35, fontSize: 38, bold: true, color: DARK, fit: 'shrink' });
    cover.addText(cleanXml(String(`${analysis.subtitle}${sourceContext}`)), { x: 1, y: 3.3, w: 11.3, h: 0.65, fontSize: 18, color: GRAY, fit: 'shrink' });
    cover.addText(cleanXml(String(`${analysis.generatedAt} · 质量分析平台 v${appVersionText()}`)), { x: 1, y: 4.05, w: 11.3, h: 0.5, fontSize: 14, color: GRAY });

    const summarySlide = pptx.addSlide();
    titleBar(summarySlide, '分析结论');
    summarySlide.addText(analysis.summary.map((line) => ({ text: cleanXml(line), options: { bullet: { indent: 18 } } })), {
      x: 0.8, y: 1.0, w: 11.8, h: analysis.warnings.length ? 2.5 : 5.6, fontSize: 17, color: DARK, breakLine: true,
      valign: 'top', margin: 0.08, fit: 'shrink',
    });
    if (analysis.warnings.length > 0) {
      summarySlide.addShape('rect', { x: 0.8, y: 4.0, w: 11.8, h: 0.06, fill: { color: 'D98324' } });
      summarySlide.addText('使用与解释注意事项', { x: 0.8, y: 4.15, w: 11.8, h: 0.4, fontSize: 15, bold: true, color: 'B0620F' });
      summarySlide.addText(analysis.warnings.map((line) => ({ text: cleanXml(line), options: { bullet: { indent: 18 } } })), {
        x: 0.8, y: 4.6, w: 11.8, h: 2.1, fontSize: 13, color: GRAY, breakLine: true,
        valign: 'top', margin: 0.08, fit: 'shrink',
      });
    }

    for (const table of analysis.tables) {
      // 幻灯片数量上限(双审 P2):大观测表可切出数百页/数百 MB;20 页(280 行)后截断并明示
      const MAX_TABLE_SLIDES = 20;
      const ROWS_PER_SLIDE = 14;
      const totalRows = analysisTableTotalRows(table);
      const materializedChunkCount = Math.max(1, Math.ceil(table.rows.length / ROWS_PER_SLIDE));
      const shownChunkCount = Math.min(materializedChunkCount, MAX_TABLE_SLIDES);
      // 只构建最终会写入的 20 个 chunk；不先把全表切成上千个临时数组。
      const chunks = Array.from({ length: shownChunkCount }, (_, index) => (
        table.rows.slice(index * ROWS_PER_SLIDE, (index + 1) * ROWS_PER_SLIDE)
      ));
      const shownRows = Math.min(table.rows.length, MAX_TABLE_SLIDES * ROWS_PER_SLIDE);
      const truncatedSlides = totalRows > shownRows;
      chunks.forEach((chunk, chunkIndex) => {
        const slide = pptx.addSlide();
        titleBar(slide, `${table.title}${chunks.length > 1 ? ` (${chunkIndex + 1}/${chunks.length})` : ''}`);
        const rows: PptxGenJS.TableRow[] = [
          table.headers.map((header) => ({ text: cleanXml(header), options: { bold: true, color: DARK } })),
          ...chunk.map((row) => row.map((value) => ({ text: cleanXml(String(value)) }))),
        ];
        slide.addTable(rows, {
          x: 0.55, y: 1.0, w: 12.2, h: 5.8, fontSize: 11,
          border: { type: 'solid', color: 'E2E5EA', pt: 1 },
          fill: { color: 'FFFFFF' }, margin: 0.05,
        });
        if (table.note) slide.addText(cleanXml(String(table.note)), { x: 0.65, y: 6.95, w: 12, h: 0.3, fontSize: 9, color: GRAY, fit: 'shrink' });
      });
      if (truncatedSlides) {
        const slide = pptx.addSlide();
        titleBar(slide, `${table.title} (已截断)`);
        slide.addText(cleanXml(tableTruncationNote(
          totalRows,
          shownRows,
          `PPT（${chunks.length} 页）`,
          totalRows === table.rows.length,
        )), {
          x: 0.9, y: 3, w: 11.5, h: 1, color: GRAY, fontSize: 16, align: 'center',
        });
      }
    }
    analysis.charts.forEach((chart, index) =>
      chartSlide(chart.title, images.analysis?.[index], chart.height / chart.width, chart.note));

    const buf = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
    return new Uint8Array(buf);
  }
  if (!assessment) throw new Error('通用 PowerPoint 报告缺少 SPC 判异结果');

  const C = capabilityModel;
  const capSpcCount = capabilitySpcViolations ?? assessment.chartPointCount;
  const { cap, capError, viol, verdictLine, violSummary, adText, capabilityOverrideAcknowledged } = collectStats(C, spec, assessment, capabilityOptions);

  // 封面
  const cover = pptx.addSlide();
  cover.addShape('rect', { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: 'F4F6F8' } });
  cover.addShape('rect', { x: 0, y: 3.0, w: 13.33, h: 0.06, fill: { color: BLUE } });
  cover.addText('质量分析报告', { x: 1, y: 1.7, w: 11.3, h: 1.1, fontSize: 44, bold: true, color: DARK });
  cover.addText(cleanXml(`${M.name} · ${reportContextText(M, C)}`), { x: 1, y: 3.3, w: 11.3, h: 0.6, fontSize: 18, color: GRAY, fit: 'shrink' });
  cover.addText(cleanXml(String(`${timestampText()} · 质量分析平台 v${appVersionText()}`)), { x: 1, y: 3.9, w: 11.3, h: 0.5, fontSize: 14, color: GRAY });

  // 概览 + 能力表
  const s2 = pptx.addSlide();
  titleBar(s2, '过程概览与能力指标');
  const rows: PptxGenJS.TableRow[] = [
    [
      { text: '能力口径均值', options: { bold: true } }, { text: withinSigmaLabel(C), options: { bold: true } },
      { text: 'σ 整体', options: { bold: true } }, { text: '规格 L/T/U', options: { bold: true } }, { text: '判定', options: { bold: true } },
    ],
    [reportNum(C.oMean, 4), reportNum(C.sigmaWithin, 4), reportNum(C.oSd, 4), reportSpecText(spec), cap ? `${capabilityVerdictText(C, cap, capSpcCount)} (Cpk ${nf(cap.cpk, 2)})` : '能力分析未运行'].map((t) => ({ text: t })),
  ];
  s2.addTable(rows, { x: 0.6, y: 1.1, w: 12.1, fontSize: 14, border: { type: 'solid', color: 'E2E5EA', pt: 1 }, fill: { color: 'FFFFFF' } });
  if (cap) {
    const capRows: PptxGenJS.TableRow[] = [
      capPairs(cap).map(([k]) => ({ text: k, options: { bold: true } })),
      capPairs(cap).map(([, v]) => ({ text: v })),
    ];
    s2.addTable(capRows, { x: 0.6, y: 2.6, w: 12.1, fontSize: 14, border: { type: 'solid', color: 'E2E5EA', pt: 1 } });
  } else {
    s2.addText(cleanXml(String(`能力分析未运行: ${capError}`)), { x: 0.6, y: 2.6, w: 12.1, h: 0.6, fontSize: 14, color: 'B0620F' });
  }
  s2.addText(cleanXml(String(adText)), { x: 0.6, y: 4.3, w: 12.1, h: 0.5, fontSize: 13, color: GRAY });
  if (capabilityOverrideAcknowledged) {
    s2.addText('⚠ 用户已核对当前测量角色与规格，并显式确认继续计算远距离规格。', {
      x: 0.6, y: 4.85, w: 12.1, h: 0.45, fontSize: 12, color: 'B0620F', fit: 'shrink',
    });
  }
  const pptxCaliberLine = capabilityCaliberLine(capabilityOptions, capSpcCount);
  if (pptxCaliberLine) {
    s2.addText(cleanXml(pptxCaliberLine), {
      x: 0.6, y: capabilityOverrideAcknowledged ? 5.35 : 4.85, w: 12.1, h: 0.6, fontSize: 12, color: 'B0620F', fit: 'shrink',
    });
  }

  chartSlide(`SPC 位置图（${assessment.locationLabel}）`, images.xbar, 250 / 960,
    viol.length === 0 ? verdictLine : officeChartViolationText(viol, violSummary, assessment.locationLabel, 8));
  chartSlide(`SPC 离散图（${assessment.dispersionLabel}）`, images.dispersion, 250 / 960,
    viol.length === 0 ? verdictLine : officeChartViolationText(viol, violSummary, assessment.dispersionLabel, 8));
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
