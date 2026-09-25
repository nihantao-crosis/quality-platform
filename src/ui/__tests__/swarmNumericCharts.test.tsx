import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  computeGagePanelData,
  computeGageRR,
  CONTROL_CONSTANTS,
  type GageObservation,
} from '../../core';
import { ControlChart } from '../charts/ControlChart';
import { GageReportFigure, gageBarCategories } from '../charts/gagePanels';
import { chartTokens } from '../tokens';

const MAXIMUM = Number.MAX_VALUE;
const T = chartTokens('经典', false);

function expectFiniteSvgNumericAttributes(markup: string): void {
  const numericAttributes = [
    ...markup.matchAll(/\b(?:x|y|x1|y1|x2|y2|cx|cy|r|width|height|viewBox|points|d|transform)="([^"]*)"/g),
  ].map((match) => match[1]);
  expect(numericAttributes.length).toBeGreaterThan(0);
  expect(numericAttributes.filter((value) => /(?:NaN|-?Infinity)/.test(value))).toEqual([]);
}

function extremeGageStudy(): GageObservation[] {
  return Array.from({ length: 8 }, (_, part) => (
    part === 0 ? [-MAXIMUM, MAXIMUM] : [0, 0]
  )).flatMap((trials, part) => trials.map((value, trial) => ({
    part,
    operator: 0,
    trial,
    value,
  })));
}

describe('有限极值图表坐标', () => {
  it('ControlChart 的 ±MAX y 轴在缩放坐标中生成有限 SVG 坐标', () => {
    const markup = renderToStaticMarkup(createElement(ControlChart, {
      T,
      data: [-MAXIMUM, 0, MAXIMUM],
      cl: 0,
      ucl: MAXIMUM,
      lcl: -MAXIMUM,
      clLabel: 'X̄',
      zones: true,
      violations: new Set<number>(),
    }));
    expectFiniteSvgNumericAttributes(markup);
  });

  it('真实 GageReportFigure 的六类面板坐标不输出 NaN/Infinity', () => {
    const observations = extremeGageStudy();
    const panel = computeGagePanelData(observations, CONTROL_CONSTANTS[2]);
    const result = computeGageRR(observations, null);
    const markup = renderToStaticMarkup(createElement(GageReportFigure, {
      T,
      panel,
      partLabels: Array.from({ length: 8 }, (_, index) => String(index + 1)),
      operatorLabels: ['甲'],
      cats: gageBarCategories(result),
      valueName: '极值测量',
    }));

    expect(markup).toContain('极值测量 的量具 R&amp;R');
    expectFiniteSvgNumericAttributes(markup);
  });
});
