/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { computeVarModel, oneWayAnova } from '../../core';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildXlsx } from '../../platform/xlsxExport';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { Anova } from '../pages/SimplePages';
import { IndividualValuePlot, IntervalPlot, groupedPlotWindow, MAX_GROUPED_PLOT_GROUPS, MAX_GROUPED_PLOT_POINTS } from '../charts/misc';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);
const SPEC = { lsl: null, tgt: 0, usl: null };

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [], lastError: null });
  useApp.setState({ page: 'anova', hypoTab: 'anova', anovaMode: 'numfactor', anovaFactorName: 'Dose', anovaRespName: 'Y', anovaShowDemo: false });
});

function installModeSwitchData() {
  useData.setState({
    model: computeVarModel('角色切换.csv', ['Dose', 'Y'], [[1, 5], [1, 9], [2, 6], [2, 10]]),
    textCols: [{ name: '设备', values: ['A', 'B', 'A', 'B'] }], pendingCells: [],
  });
}

function installGroups(count: number) {
  const groups = Array.from({ length: count }, (_, i) => ({ name: `G${String(i + 1).padStart(5, '0')}`, vals: [100 + i % 7, 101 + i % 7] }));
  useData.setState({
    model: computeVarModel('高基数.csv', ['Y'], groups.flatMap((group) => group.vals.map((value) => [value]))),
    textCols: [{ name: '设备', values: groups.flatMap((group) => group.vals.map(() => group.name)) }], pendingCells: [],
  });
  useApp.setState({ anovaMode: 'stacked', anovaFactorName: '设备', anovaRespName: 'Y' });
  return groups;
}

function activeReport() {
  const report = buildActiveAnalysisReport();
  expect(report?.kind).toBe('anova');
  return report!;
}

describe('F-01 生产页面、保存和四格式报告角色回归', () => {
  it('点击数值因子→文本长表→数值因子，标签、观测、P 和保存快照保持一致', () => {
    installModeSwitchData();
    const view = render(<Anova T={T} />);
    expect(view.container.textContent).toContain('Y vs Dose');
    expect(activeReport().tables[1].rows[0]).toEqual(['Dose', 1, '1.000000', '1.000000', '0.12500', '0.757464']);

    fireEvent.click(view.getByRole('button', { name: '分组列(长表)' }));
    // 不修改 store 中的旧选择，以覆盖原始漏洞的真实触发路径。
    expect(useApp.getState().anovaFactorName).toBe('Dose');
    expect(view.container.textContent).toContain('Y vs 设备');
    expect(view.container.textContent).toContain('各「设备」组均值存在显著差异');
    const report = activeReport();
    expect(report.subtitle).toBe('Y vs 设备 · 长表分组');
    expect(report.tables[0].headers).toEqual(['工作表行', '设备', 'Y']);
    expect(report.tables[0].rows.map((row) => row[1])).toEqual(['A', 'B', 'A', 'B']);
    expect(report.tables[1].rows[0]).toEqual(['设备', 1, '16.000000', '16.000000', '32.00000', '0.029857']);
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved).toMatchObject({ metric: 'P 0.030', status: '显著', snapshot: { anovaMode: 'stacked', anovaFactorName: '设备', anovaRespName: 'Y' } });

    fireEvent.click(view.getByRole('button', { name: '数值因子' }));
    expect(view.container.textContent).toContain('Y vs Dose');
    expect(activeReport().tables[1].rows[0][5]).toBe('0.757464');
    expect(useAnalyses.getState().saveCurrent()?.snapshot.anovaFactorName).toBe('Dose');
  });

  it('HTML、Excel、Word、PPT 的真实格式出口都使用设备，不再把 A/B 归在 Dose 下', async () => {
    installModeSwitchData();
    useApp.setState({ anovaMode: 'stacked' });
    const report = activeReport();
    const model = useData.getState().model;
    const html = buildHtmlReport(model, SPEC, null, report);
    const book = XLSX.read(buildXlsx(model, SPEC, null, report), { type: 'array' });
    const cells = XLSX.utils.sheet_to_json<string[]>(book.Sheets[book.SheetNames[0]], { header: 1 }).flat().join('|');
    // Office 正文验证使用真实 OOXML 打包；图片渲染由独立浏览器验收覆盖。
    const [docxBytes, pptxBytes] = await Promise.all([buildDocx(model, SPEC, {}, null, report), buildPptx(model, SPEC, {}, null, report)]);
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
    const docxText = await docx.file('word/document.xml')!.async('string');
    const pptxText = (await Promise.all(Object.values(pptx.files).filter((file) => /^ppt\/slides\/slide\d+\.xml$/.test(file.name)).map((file) => file.async('string')))).join('');
    for (const text of [html, cells, docxText, pptxText]) {
      expect(text).toContain('Y vs 设备');
      expect(text).toContain('0.029857');
      expect(text).not.toContain('Dose');
    }
  });
});

describe('P-01 分组图总预算和全量统计回归', () => {
  it.each([1000, 5000])('%i 组的生产报告两张 SVG 均只展开 12 组，统计和表格仍含全部组', (count) => {
    const groups = installGroups(count);
    const expected = oneWayAnova(groups.map((group) => group.vals));
    const report = activeReport();
    const [individual, interval] = report.charts;
    const svgs = [individual.svg, interval.svg];
    const bytes = new TextEncoder().encode(svgs.join('')).length;
    const elements = svgs.reduce((sum, svg) => sum + new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('*').length, 0);
    expect(bytes).toBeLessThan(80_000);
    expect(elements).toBeLessThan(500);
    for (const chart of [individual, interval]) {
      expect(chart.note).toContain(`显示第 1–12 组，共 ${count} 组`);
      expect(chart.svg).toContain(`显示第 1–12 组，共 ${count} 组`);
      expect(chart.svg).not.toContain('G00013');
      expect(chart.svg).not.toMatch(/NaN|Infinity/);
    }
    expect(individual.svg.match(/<circle/g)).toHaveLength(MAX_GROUPED_PLOT_GROUPS * 2);
    expect(interval.svg.match(/<circle/g)).toHaveLength(MAX_GROUPED_PLOT_GROUPS);
    expect(report.tables[1].rows[0][1]).toBe(expected.factorDf);
    expect(report.tables[1].rows[1][1]).toBe(expected.errorDf);
    expect(Number(report.tables[1].rows[0][4])).toBeCloseTo(expected.fStat, 4);
    expect(report.tables[0].totalRows).toBe(count * 2);
    expect(report.tables[2].rows).toHaveLength(count);
    expect(report.tables[2].rows[count - 1][0]).toBe(groups[count - 1].name);
    expect(report.warnings.join('')).toContain('统计使用全部组与观测');
    console.info(`ANOVA ${count} groups: ${bytes} SVG bytes, ${elements} elements`);
  });

  it('页面三种组图和描述表同步翻页，末页可见且 F/P 不随页码改变', () => {
    installGroups(25);
    const view = render(<Anova T={T} />);
    const anovaRows = () => view.container.querySelectorAll('table')[0].textContent;
    const summaryRows = () => view.container.querySelectorAll('table')[1].querySelectorAll('tbody tr');
    const fullAnovaText = anovaRows();
    expect(summaryRows()).toHaveLength(12);
    expect(view.getByRole('img', { name: /显示第 1–12 组，共 25 组/ })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '下一组页' }));
    fireEvent.click(view.getByRole('button', { name: '个体值图' }));
    const individual = view.getByRole('img', { name: /个体值图；显示第 13–24 组/ });
    expect(individual.querySelectorAll('circle')).toHaveLength(24);
    expect(individual.textContent).toContain('G00013');
    expect(individual.textContent).not.toContain('G00001');
    expect(summaryRows()).toHaveLength(12);
    expect(anovaRows()).toBe(fullAnovaText);
    fireEvent.click(view.getByRole('button', { name: '下一组页' }));
    fireEvent.click(view.getByRole('button', { name: '区间图' }));
    const interval = view.getByRole('img', { name: /显示第 25–25 组，共 25 组/ });
    expect(interval.querySelectorAll('circle')).toHaveLength(1);
    expect(interval.textContent).toContain('G00025');
    expect(summaryRows()).toHaveLength(1);
    expect((view.getByRole('button', { name: '下一组页' }) as HTMLButtonElement).disabled).toBe(true);
    expect(anovaRows()).toBe(fullAnovaText);
  });

  it('单组点抽样保留极值但包含额外保留点的总数也不超过 1200', () => {
    const groups = Array.from({ length: 1000 }, (_, group) => ({
      name: `group-${group}`,
      vals: Array.from({ length: 203 }, (_, i) => i === 59 ? -9999 : i === 71 ? 9999 : i),
    }));
    const svg = renderToStaticMarkup(<IndividualValuePlot T={T} groups={groups} />);
    expect((svg.match(/<circle/g) ?? []).length).toBeLessThanOrEqual(MAX_GROUPED_PLOT_POINTS);
    expect(svg).toContain('group-0 · -9999.0000');
    expect(svg).toContain('group-0 · 9999.0000');
    expect(svg).toContain('渲染');
    expect(groupedPlotWindow(groups, Infinity).start).toBe(0);
    expect(groupedPlotWindow(groups, 1_000_000)).toMatchObject({ start: 996, end: 1000 });
    expect(groupedPlotWindow(groups, -24).start).toBe(0);
  });

  it('区间图以全部组的合并误差绘图，不因显示组截断而重估 MSE', () => {
    const groups = Array.from({ length: 25 }, (_, i) => ({ name: `g${i}`, vals: i < 12 ? [0, 1] : [0, 50] }));
    const full = oneWayAnova(groups.map((group) => group.vals));
    const svg = renderToStaticMarkup(<IntervalPlot T={T} groups={groups} pooledError={{ mse: full.errorMS, df: full.errorDf }} />);
    const firstPage = renderToStaticMarkup(<IntervalPlot T={T} groups={groups.slice(0, 12)} pooledError={{ mse: full.errorMS, df: full.errorDf }} />);
    const tooltip = (markup: string) => [...new DOMParser().parseFromString(markup, 'image/svg+xml').querySelectorAll('circle title')].map((node) => node.textContent);
    expect(tooltip(svg)).toEqual(tooltip(firstPage));
    expect(svg).toContain('df=25');
  });
});
