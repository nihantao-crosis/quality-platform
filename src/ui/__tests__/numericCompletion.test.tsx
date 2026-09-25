import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Histogram } from '../charts/Histogram';
import { chartTokens } from '../tokens';

const MAXIMUM = Number.MAX_VALUE;
const T = chartTokens('经典', false);

function labelX(markup: string, label: string): number {
  const match = markup.match(new RegExp(`<text x="([^"]+)"[^>]*>${label}</text>`));
  expect(match, `未找到 ${label} 标签`).not.toBeNull();
  return Number(match![1]);
}

describe('Histogram 极值共同坐标域', () => {
  it('±MAX 的 LSL < 目标 < USL，两端数据柱也落在各自一侧', () => {
    const markup = renderToStaticMarkup(createElement(Histogram, {
      T,
      data: [-MAXIMUM, MAXIMUM],
      mu: 0,
      sigmaWithin: MAXIMUM,
      sigmaOverall: MAXIMUM,
      lsl: -MAXIMUM,
      tgt: 0,
      usl: MAXIMUM,
      h: 320,
      bins: 13,
    }));

    expect(markup).not.toMatch(/(?:NaN|-?Infinity)/);
    const lsl = labelX(markup, 'LSL');
    const target = labelX(markup, '目标');
    const usl = labelX(markup, 'USL');
    expect(lsl).toBeLessThan(target);
    expect(target).toBeLessThan(usl);

    const bars = [...markup.matchAll(
      /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"[^>]*opacity="0\.82"[^>]*><\/rect>/g,
    )].map((match) => ({
      x: Number(match[1]),
      width: Number(match[3]),
      height: Number(match[4]),
    })).filter((bar) => bar.height > 0);
    expect(bars).toHaveLength(2);
    const centers = bars.map((bar) => bar.x + bar.width / 2).sort((a, b) => a - b);
    expect(centers[0]).toBeLessThan(target);
    expect(centers[1]).toBeGreaterThan(target);
    expect(centers[1] - centers[0]).toBeGreaterThan((usl - lsl) * 0.8);
  });
});
