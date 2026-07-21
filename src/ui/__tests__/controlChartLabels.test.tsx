/** 控制图显示序号可映射回原始观测号（MR 首点 = 原始观测 2）。 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ControlChart } from '../charts/ControlChart';
import { chartTokens } from '../tokens';

describe('ControlChart 原始序号映射', () => {
  it('tooltip 与 X 轴共同应用 MR 的 +1 偏移', () => {
    const svg = renderToStaticMarkup(createElement(ControlChart, {
      T: chartTokens('经典', true),
      data: [0.2, 0.3], cl: 0.25, ucl: 0.5, lcl: 0,
      xIndexOffset: 1,
      ptLabel: (i: number) => `观测 ${i + 2}`,
    }));
    expect(svg).toContain('观测 2 = 0.200');
    expect(svg).toContain('观测 3 = 0.300');
    expect(svg).toMatch(/>2<\/text>/);
    expect(svg).toMatch(/>3<\/text>/);
  });

  it('未传 ptLabel 时默认 tooltip 也应用 MR 的 +1 偏移', () => {
    const svg = renderToStaticMarkup(createElement(ControlChart, {
      T: chartTokens('经典', true),
      data: [20, 20], cl: 10, ucl: 15, lcl: 0,
      xIndexOffset: 1,
    }));
    expect(svg).toContain('点 2 = 20.000');
    expect(svg).toContain('点 3 = 20.000');
    expect(svg).not.toContain('点 1 = 20.000');
  });

  it('显示变量名相关的 X/Y 轴语义，并可用真实子组 ID 代替序号', () => {
    const svg = renderToStaticMarkup(createElement(ControlChart, {
      T: chartTokens('经典', true),
      data: [10, 11], cl: 10.5, ucl: 12, lcl: 9,
      xLabels: ['批次-A', '批次-B'], xLabel: '子组（批次）', yLabel: '直径 · 子组均值',
      ptLabel: (i: number) => `子组 ${['批次-A', '批次-B'][i]}`,
    }));
    expect(svg).toContain('子组（批次）');
    expect(svg).toContain('直径 · 子组均值');
    expect(svg).toContain('批次-A');
    expect(svg).toContain('批次-B');
    expect(svg).toContain('子组 批次-A = 10.000');
  });
});
