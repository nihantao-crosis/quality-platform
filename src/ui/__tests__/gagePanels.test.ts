/** MSA 图形面板纯计算:Minitab 默认箱线规则(1.5×IQR 箱须 + 星号离群点)。 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GagePanelData } from '../../core';
import { mean } from '../../core';
import {
  boxplotStats,
  GageByOperatorPanel,
  GageInteractionPanel,
  gageInteractionSeriesStyle,
} from '../charts/gagePanels';
import { chartTokens } from '../tokens';

describe('boxplotStats — Minitab 1.5×IQR 箱线规则(Codex 复审 P1)', () => {
  it('Minitab 官方十值示例使用 (n+1)p：Q1=14.25、Q3=46.50', () => {
    const stats = boxplotStats([7, 9, 16, 36, 39, 45, 45, 46, 48, 51]);
    expect(stats.q1).toBeCloseTo(14.25, 12);
    expect(stats.median).toBeCloseTo(42, 12);
    expect(stats.q3).toBeCloseTo(46.5, 12);
    expect(stats.whiskerLo).toBe(7);
    expect(stats.whiskerHi).toBe(51);
    expect(stats.outliers).toEqual([]);
  });

  it('箱须延伸到栅栏内最远相邻值,不是最小/最大;栅栏外单独作离群点', () => {
    // 主体 10 个点集中在 10±0.5,两个明显离群(6 与 15)
    const values = [9.5, 9.7, 9.8, 10.0, 10.0, 10.1, 10.2, 10.3, 10.4, 10.5, 6.0, 15.0];
    const stats = boxplotStats(values);
    expect(stats.outliers).toEqual([6.0, 15.0]);
    // 箱须端点是栅栏内的真实数据点,不是被离群点拉到 6/15
    expect(stats.whiskerLo).toBe(9.5);
    expect(stats.whiskerHi).toBe(10.5);
    expect(stats.q1).toBeGreaterThan(9.5);
    expect(stats.q3).toBeLessThan(10.5);
    expect(stats.median).toBeCloseTo(10.05, 10);
  });

  it('工厂案例5 形态:三人 90 点中的孤立低值(23.52/23.56)与高值(26.16)按 Minitab 规则可分离', () => {
    // 谷春莉块的缩影:主体 24.5–25.8,含 23.52/23.56/24.27/26.16 等极端值
    const values = [
      25.03, 25.17, 25.02, 25.2, 24.58, 24.93, 24.84, 24.73, 25.57, 25.68,
      23.56, 24.27, 24.92, 25.23, 24.77, 24.87, 24.74, 24.8, 25.6, 25.71,
      25.05, 23.52, 24.94, 26.16, 24.74, 24.88, 24.77, 24.58, 25.7, 25.74,
    ];
    const stats = boxplotStats(values);
    // 明显离群的 23.52/23.56 必须以星号显示,不能被箱须吸收
    expect(stats.outliers).toContain(23.52);
    expect(stats.outliers).toContain(23.56);
    expect(stats.whiskerLo).toBeGreaterThan(23.6);
    expect(stats.whiskerHi).toBeLessThanOrEqual(26.16);
  });

  it('无离群点时箱须退化为最小/最大值,离群列表为空', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    const stats = boxplotStats(values);
    expect(stats.outliers).toEqual([]);
    expect(stats.whiskerLo).toBe(1);
    expect(stats.whiskerHi).toBe(8);
  });
});

describe('Gage 操作员均值标记', () => {
  it('1e9±微扰观测重排后复用面板稳定均值，SVG标记不漂移', () => {
    const base = 1e9;
    const low = base - 5e-6;
    const high = base + 5e-6;
    const blocked = [...Array(50).fill(low), ...Array(450).fill(high)] as number[];
    const operatorMean = mean(blocked);
    const panel = (values: number[]): GagePanelData => ({
      partCount: 1,
      operatorCount: 1,
      trialCount: values.length,
      cellMeans: [[operatorMean]],
      cellRanges: [[high - low]],
      partMeans: [operatorMean],
      operatorMeans: [operatorMean],
      values: [[values]],
      grandMean: operatorMean,
      rBar: high - low,
      rLimits: null,
      xbarLimits: null,
    });
    const render = (values: number[]) => renderToStaticMarkup(createElement(GageByOperatorPanel, {
      T: chartTokens('经典', false), panel: panel(values), partLabels: ['1'], operatorLabels: ['甲'],
    }));
    expect(render(blocked)).toBe(render([...blocked].reverse()));
  });
});

describe('Gage 交互图操作员编码', () => {
  it('至少 4 名操作员拥有各自唯一的颜色、形状和线型', () => {
    const styles = Array.from({ length: 4 }, (_, operator) => gageInteractionSeriesStyle(operator));
    expect(new Set(styles.map((style) => style.color)).size).toBe(4);
    expect(new Set(styles.map((style) => style.marker)).size).toBe(4);
    expect(new Set(styles.map((style) => style.dash ?? 'solid')).size).toBe(4);
  });

  it('数据线与图例复用同一组颜色/线型/标记', () => {
    const panel: GagePanelData = {
      partCount: 2,
      operatorCount: 4,
      trialCount: 2,
      cellMeans: [[1, 2], [1.2, 2.1], [0.9, 2.2], [1.1, 1.8]],
      cellRanges: [[0.1, 0.1], [0.1, 0.1], [0.1, 0.1], [0.1, 0.1]],
      partMeans: [1.05, 2.025],
      operatorMeans: [1.5, 1.65, 1.55, 1.45],
      values: [
        [[0.95, 1.05], [1.95, 2.05]],
        [[1.15, 1.25], [2.05, 2.15]],
        [[0.85, 0.95], [2.15, 2.25]],
        [[1.05, 1.15], [1.75, 1.85]],
      ],
      grandMean: 1.55625,
      rBar: 0.1,
      rLimits: null,
      xbarLimits: null,
    };
    const markup = renderToStaticMarkup(createElement(GageInteractionPanel, {
      T: chartTokens('经典', false),
      panel,
      partLabels: ['1', '2'],
      operatorLabels: ['甲', '乙', '丙', '丁'],
    }));
    for (let operator = 0; operator < 4; operator++) {
      const style = gageInteractionSeriesStyle(operator);
      expect(markup.split(style.color).length - 1, `操作员 ${operator + 1} 颜色未同时出现在数据与图例`).toBeGreaterThanOrEqual(4);
      if (style.dash) {
        expect(markup.split(`stroke-dasharray="${style.dash}"`).length - 1).toBeGreaterThanOrEqual(2);
      }
    }
    expect(markup).toContain('甲');
    expect(markup).toContain('乙');
    expect(markup).toContain('丙');
    expect(markup).toContain('丁');
  });
});
