/** @vitest-environment jsdom */
import JSZip from 'jszip';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildDocx, buildPptx, renderReportImages } from '../../platform/officeExport';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { createPowerOfTwoAxis } from '../charts/axisScale';
import { NormalProbPlot, residualAxisScale } from '../charts/NormalProbPlot';
import { ScatterPlot } from '../charts/ScatterPlot';
import { BoxPlot, IndividualValuePlot, IntervalPlot, MiniHist } from '../charts/misc';
import { Summary } from '../pages/Summary';
import { chartTokens } from '../tokens';

const MAXIMUM = Number.MAX_VALUE;
const EXTREMES = [-MAXIMUM, 0, MAXIMUM];
const T = chartTokens('经典', true);
const SPEC = { lsl: null, tgt: 0, usl: null };
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));

class LoadedImage {
  onload: ((this: GlobalEventHandlers, event: Event) => unknown) | null = null;
  onerror: OnErrorEventHandler = null;
  private value = '';

  set src(value: string) {
    this.value = value;
    queueMicrotask(() => this.onload?.call(this as unknown as GlobalEventHandlers, new Event('load')));
  }

  get src(): string { return this.value; }
}

function expectFiniteSvgNumericAttributes(markup: string): void {
  const attributes = [
    ...markup.matchAll(/\b(?:x|y|x1|y1|x2|y2|cx|cy|r|width|height|viewBox|points|d|transform)="([^"]*)"/g),
  ].map((match) => match[1]);
  expect(attributes.length).toBeGreaterThan(0);
  for (const attribute of attributes) {
    expect(attribute).not.toMatch(/(?:NaN|-?Infinity)/);
    const numbers = attribute.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
    for (const token of numbers) expect(Number.isFinite(Number(token)), `${token} in ${attribute}`).toBe(true);
  }
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'summary', activeVar: '', modal: null, toast: null,
    lslOn: false, uslOn: false, tgt: 0,
  });
  vi.stubGlobal('Image', LoadedImage);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true, writable: true, value: vi.fn(() => 'blob:extreme-axis'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true, writable: true, value: vi.fn(() => undefined),
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob([PNG], { type: 'image/png' }));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('二次幂坐标域的极值消费方', () => {
  it('普通量程保持 scale=1，极值量程才切换坐标', () => {
    const ordinary = createPowerOfTwoAxis([-10, 0, 20]);
    expect(ordinary.scale).toBe(1);
    expect([-10, 0, 20].map(ordinary.coordinate)).toEqual([-10, 0, 20]);
    expect([-10, 0, 20].map(ordinary.restore)).toEqual([-10, 0, 20]);

    const extreme = createPowerOfTwoAxis(EXTREMES);
    expect(extreme.scaled).toBe(true);
    expect(EXTREMES.map(extreme.coordinate).every(Number.isFinite)).toBe(true);
    expect(EXTREMES.map(extreme.coordinate).map(extreme.restore)).toEqual(EXTREMES);
  });

  it('概率图、散点图和 misc 数值轴不向 SVG 输出非有限属性', () => {
    const groups = [
      { name: 'A', vals: EXTREMES },
      { name: 'B', vals: [MAXIMUM, 0, -MAXIMUM] },
    ];
    const charts: Array<[string, string]> = [
      ['NormalProbPlot', renderToStaticMarkup(createElement(NormalProbPlot, { T, data: EXTREMES, h: 260 }))],
      ['ScatterPlot', renderToStaticMarkup(createElement(ScatterPlot, {
        T, xs: EXTREMES, ys: EXTREMES, slope: 1, intercept: 0, xLabel: 'X', yLabel: 'Y', h: 260,
      }))],
      ['BoxPlot', renderToStaticMarkup(createElement(BoxPlot, { T, groups }))],
      ['IndividualValuePlot', renderToStaticMarkup(createElement(IndividualValuePlot, { T, groups, h: 260 }))],
      ['IntervalPlot', renderToStaticMarkup(createElement(IntervalPlot, { T, groups, h: 260 }))],
      ['MiniHist', renderToStaticMarkup(createElement(MiniHist, { T, data: EXTREMES, h: 220 }))],
    ];

    for (const [name, markup] of charts) {
      expect(markup, name).not.toMatch(/(?:NaN|-?Infinity)/);
      expectFiniteSvgNumericAttributes(markup);
    }

    const sharedResidualAxis = residualAxisScale(EXTREMES);
    expect([...sharedResidualAxis.domain, ...sharedResidualAxis.ticks].every(Number.isFinite)).toBe(true);
    expect(sharedResidualAxis.domain[1]).toBeGreaterThan(sharedResidualAxis.domain[0]);
  });

  it('Summary 真页面的直方图与内嵌箱线图属性全部有限', () => {
    useData.getState().importMatrix('极值汇总.csv', ['测量值'], EXTREMES.map((value) => [value]));
    useApp.setState({ page: 'summary', activeVar: '测量值' });
    const view = render(createElement(Summary, { T }));
    const svgs = [...view.container.querySelectorAll('svg')];
    expect(svgs.length).toBeGreaterThanOrEqual(2);
    for (const svg of svgs) expectFiniteSvgNumericAttributes(svg.outerHTML);
  });

  it('真实 active report 可写入 HTML 并经 SVG→PNG 嵌入 Word/PPT', async () => {
    useData.getState().importMatrix('极值报告.csv', ['测量值'], EXTREMES.map((value) => [value]));
    useApp.setState({ page: 'summary', activeVar: '测量值' });
    const report = buildActiveAnalysisReport();
    expect(report?.kind).toBe('summary');
    expect(report?.charts.length).toBeGreaterThanOrEqual(2);
    for (const chart of report?.charts ?? []) expectFiniteSvgNumericAttributes(chart.svg);

    const model = useData.getState().model;
    const html = buildHtmlReport(model, SPEC, null, report);
    expect(html).toContain('描述性统计专项报告');
    expect(html).not.toMatch(/(?:x|y|x1|y1|x2|y2|cx|cy|points|d)="[^"]*(?:NaN|-?Infinity)/);

    const images = await renderReportImages(model, SPEC, null, report);
    expect(images.analysis).toHaveLength(report?.charts.length ?? 0);
    const [docxBytes, pptxBytes] = await Promise.all([
      buildDocx(model, SPEC, images, null, report),
      buildPptx(model, SPEC, images, null, report),
    ]);
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
    const wordMedia = Object.keys(docx.files).filter((name) => name.startsWith('word/media/') && !docx.files[name].dir);
    const pptMedia = Object.keys(pptx.files).filter((name) => name.startsWith('ppt/media/') && !pptx.files[name].dir);
    expect(wordMedia.length).toBeGreaterThan(0);
    expect(pptMedia.length).toBeGreaterThan(0);
  }, 30_000);
});
