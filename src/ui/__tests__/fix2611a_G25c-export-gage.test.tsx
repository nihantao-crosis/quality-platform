/** @vitest-environment jsdom */
/**
 * fix2611a G25c-export C4(附录 F.3-15):MSA 图形报告声明画布尺寸 = 实际 SVG 尺寸(单一来源常量);
 * C5(附录 F.3-17/F.3-26):gagePanels 每个 <Svg> 有具体中文无障碍名称;officeExport 不再对字面量空转 cleanXml。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeGagePanelData, computeGageRR, computeVarModel, CONTROL_CONSTANTS, gageStudyData, GAGE_TOLERANCE, type GageObservation,
} from '../../core';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import * as gagePanels from '../charts/gagePanels';
import {
  GageByOperatorPanel, GageByPartPanel, GageInteractionPanel, GageRPanel, GageReportFigure, GageXbarPanel,
  gageBarCategories,
} from '../charts/gagePanels';
import { chartTokens } from '../tokens';

afterEach(() => {
  useData.getState().resetDemo();
});

function viewBoxSize(svg: string): { width: number; height: number } {
  const match = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!match) throw new Error('SVG 缺少 viewBox');
  return { width: Number(match[1]), height: Number(match[2]) };
}

function gageFixture(operators: string[], trials: number) {
  const parts = ['P1', 'P2', 'P3', 'P4', 'P5'];
  const rows: number[][] = [];
  const partCol: string[] = [];
  const operatorCol: string[] = [];
  parts.forEach((part, p) => operators.forEach((operator, o) => {
    for (let t = 0; t < trials; t++) {
      rows.push([10 + p + o * 0.05 + ((p * 7 + o * 3 + t * 5) % 4) * 0.01]);
      partCol.push(part);
      operatorCol.push(operator);
    }
  }));
  return { rows, partCol, operatorCol };
}

function msaReport(operators: string[], trials: number) {
  const fixture = gageFixture(operators, trials);
  useData.setState({
    model: computeVarModel('msa.csv', ['Y'], fixture.rows),
    textCols: [{ name: 'Part', values: fixture.partCol }, { name: 'Operator', values: fixture.operatorCol }],
    pendingCells: [],
  });
  useApp.setState({
    page: 'gagerr', gageUseReal: true,
    gageValueName: 'Y', gagePartName: 'Part', gageOperatorName: 'Operator',
    gageTolMode: 'width', gageTolValue: 1, gageStandard: 'factory',
    gageBatchCols: null, gageTolByCol: {},
    gageGaugeName: '', gageReportBy: '', gageStudyDate: '', gageNotes: '',
  });
  const report = buildActiveAnalysisReport();
  if (!report) throw new Error('MSA 报告未生成');
  return report;
}

describe('C4 · MSA 图形报告声明尺寸与 SVG 实际尺寸一致', () => {
  it('多操作员 6 联:声明 width/height = SVG viewBox(1156×1090)', () => {
    const chart = msaReport(['A', 'B', 'C'], 2).charts[0];
    expect(chart.title).toContain('6 联');
    expect({ width: chart.width, height: chart.height }).toEqual(viewBoxSize(chart.svg));
    expect(viewBoxSize(chart.svg)).toEqual({ width: 1156, height: 1090 });
  });

  it('单操作员 4 联:声明 width/height = SVG viewBox(1156×762)', () => {
    const chart = msaReport(['A'], 3).charts[0];
    expect(chart.title).toContain('4 联');
    expect({ width: chart.width, height: chart.height }).toEqual(viewBoxSize(chart.svg));
    expect(viewBoxSize(chart.svg)).toEqual({ width: 1156, height: 762 });
  });

  it('尺寸常量从 gagePanels 单一导出', () => {
    const size = (gagePanels as unknown as { gageReportFigureSize?: (single: boolean) => { width: number; height: number } }).gageReportFigureSize;
    expect(size?.(true)).toEqual({ width: 1156, height: 762 });
    expect(size?.(false)).toEqual({ width: 1156, height: 1090 });
  });
});

describe('C5 · gagePanels 无障碍名称与 cleanXml 空转', () => {
  const T = chartTokens('经典', true);
  const observations: GageObservation[] = gageStudyData();
  const result = computeGageRR(observations, { mode: 'width', value: GAGE_TOLERANCE });
  const panel = computeGagePanelData(observations, CONTROL_CONSTANTS[result.trialCount] ?? null);
  const partLabels = Array.from({ length: panel.partCount }, (_, i) => `P${i + 1}`);
  const operatorLabels = Array.from({ length: panel.operatorCount }, (_, i) => `O${i + 1}`);
  const props = { T, panel, partLabels, operatorLabels };

  it('每个 <Svg> 都有具体中文名称,不落回通用名', () => {
    const markups: Array<[string, string]> = [
      ['R', renderToStaticMarkup(createElement(GageRPanel, props))],
      ['Xbar', renderToStaticMarkup(createElement(GageXbarPanel, props))],
      ['byPart', renderToStaticMarkup(createElement(GageByPartPanel, props))],
      ['byOperator', renderToStaticMarkup(createElement(GageByOperatorPanel, props))],
      ['interaction', renderToStaticMarkup(createElement(GageInteractionPanel, props))],
      ['figure', renderToStaticMarkup(createElement(GageReportFigure, { ...props, cats: gageBarCategories(result), valueName: '直径' }))],
    ];
    const names = markups.map(([key, markup]) => {
      const label = /<svg[^>]*aria-label="([^"]+)"/.exec(markup)?.[1];
      expect(label, key).toBeTruthy();
      expect(label, key).not.toBe('统计图表');
      expect(label, key).toMatch(/^量具研究 · /);
      return label;
    });
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('量具研究 · 按部件的测量值');
    expect(names[names.length - 1]).toContain('直径');
  });

  it('officeExport 不对编译期字面量调用 cleanXml', () => {
    const source = readFileSync(resolve(__dirname, '../../platform/officeExport.tsx'), 'utf8');
    expect(source).not.toMatch(/cleanXml\('[^'$]*'\)/);
  });
});
