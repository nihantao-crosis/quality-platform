/** DOE 图形的零效应/常数数据边界。 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EffectsBar, InteractionPlot, MainEffects } from '../charts/doe';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);

describe('DOE 常数图形', () => {
  it('主效应均为 0 时不产生 NaN 坐标', () => {
    const svg = renderToStaticMarkup(createElement(MainEffects, {
      T,
      factors: [{ name: 'A', lo: 0, hi: 0 }, { name: 'B', lo: 0, hi: 0 }],
    }));
    expect(svg).not.toContain('NaN');
  });

  it('四个交互单元均值相同时不产生 NaN 坐标', () => {
    const svg = renderToStaticMarkup(createElement(InteractionPlot, {
      T, c00: 0, c10: 0, c01: 0, c11: 0, labelA: 'A', labelB: 'B',
    }));
    expect(svg).not.toContain('NaN');
  });

  it('效应与参考线全为 0 时帕累托图仍为有限坐标', () => {
    const svg = renderToStaticMarkup(createElement(EffectsBar, {
      T, terms: [{ name: 'A', abs: 0 }], refLine: 0,
    }));
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('Infinity');
  });

  it('极小非零量纲仍按相对画幅绘制，不被 1e-9 显示下限压扁', () => {
    const svg = renderToStaticMarkup(createElement(EffectsBar, {
      T, terms: [{ name: 'A', abs: 2e-18, sig: true }], refLine: 1e-18,
    }));
    const width = Number(svg.match(/<rect x="88"[^>]*width="([^"]+)"/)?.[1]);
    expect(width).toBeGreaterThan(100);
    expect(svg).not.toContain('NaN');
  });
});
