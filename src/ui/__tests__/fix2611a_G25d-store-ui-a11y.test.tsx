/**
 * fix2611a G25d D4/D5:控制图 roving tabindex 与图表具体无障碍名称。
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { chartTokens } from '../tokens';
import { ControlChart } from '../charts/ControlChart';
import { EffectsBar, CubePlot } from '../charts/doe';
import { EffectsNormalPlot } from '../charts/EffectsNormalPlot';
import { OcCurveChart } from '../charts/OcCurveChart';
import { OcCurvePer100 } from '../charts/OcCurvePer100';
import { ScatterPlot } from '../charts/ScatterPlot';
import { BoxPlot, GroupedBars, IndividualValuePlot, IntervalPlot, MiniHist, ParetoChart } from '../charts/misc';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';

const T = chartTokens('经典', true);

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useApp.setState({ page: 'dashboard', modal: null, openMenu: null, toast: null, spcType: 'xbar-r', selSub: null, chartStyle: '经典' });
  cancelPendingDatasetWork();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
});

describe('D4 控制图 roving tabindex', () => {
  const data = Array.from({ length: 650 }, (_, i) => 10 + Math.sin(i / 7));

  it('600+ 点时整张图只有 1 个 Tab 停靠点，方向键移动、Enter/空格触发 onPoint、点击不变', () => {
    const onPoint = vi.fn();
    const { container } = render(createElement(ControlChart, {
      T, data, cl: 10, ucl: 12, lcl: 8, clLabel: 'X̄', violations: new Set<number>(), onPoint,
    }));
    const buttons = container.querySelectorAll('[role="button"]');
    expect(buttons.length).toBeGreaterThan(500);
    const stops = container.querySelectorAll('[tabindex="0"]');
    expect(stops.length, '每个点都是 Tab 停靠点').toBe(1);
    const first = stops[0] as SVGElement;
    expect(first.getAttribute('aria-label')).toMatch(/^点 1，值 .*查看明细/);

    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const second = document.activeElement as SVGElement;
    expect(second).not.toBe(first);
    expect(second.getAttribute('aria-label')).toMatch(/^点 2，/);
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(second.getAttribute('tabindex')).toBe('0');
    expect(first.getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(second, { key: 'Enter' });
    expect(onPoint).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(second, { key: ' ' });
    expect(onPoint).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(second, { key: 'End' });
    const last = document.activeElement as SVGElement;
    expect(last.getAttribute('aria-label')).toMatch(/^点 650，/);
    fireEvent.keyDown(last, { key: 'ArrowRight' }); // 末端不越界
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowLeft' }); // 首端不越界
    expect(document.activeElement).toBe(first);

    fireEvent.click(buttons[10]);
    expect(onPoint).toHaveBeenLastCalledWith(Number((buttons[10] as SVGElement).getAttribute('data-point')));
  });

  it('选中点优先作为停靠点；无 onPoint 的静态图无任何停靠点', () => {
    const { container } = render(createElement(ControlChart, {
      T, data: data.slice(0, 30), cl: 10, ucl: 12, lcl: 8, violations: new Set<number>(), sel: 7, onPoint: () => {},
    }));
    const stops = container.querySelectorAll('[tabindex="0"]');
    expect(stops).toHaveLength(1);
    expect(stops[0].getAttribute('aria-label')).toMatch(/^点 8，/);
    cleanup();
    const { container: plain } = render(createElement(ControlChart, {
      T, data: data.slice(0, 30), cl: 10, ucl: 12, lcl: 8, violations: new Set<number>(),
    }));
    expect(plain.querySelectorAll('[tabindex]')).toHaveLength(0);
  });
});

function ariaLabelOf(markup: string): string | null {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host.querySelector('svg')?.getAttribute('aria-label') ?? null;
}

describe('D5 图表具体无障碍名称', () => {
  const cases: Array<[string, ReactElement, RegExp]> = [
    ['效应帕累托', createElement(EffectsBar, { T, terms: [{ name: 'A', abs: 3 }, { name: 'B', abs: 0.2 }], refLine: 1 }), /^效应帕累托图 · 2 项.*显著项：A$/],
    ['立方图', createElement(CubePlot, { T, y: () => 1, labels: ['温度', '压力', '时间'] }), /^立方图 · 温度 × 压力 × 时间$/],
    ['效应正态', createElement(EffectsNormalPlot, { T, terms: [{ name: 'A', effect: 2, sig: true }, { name: 'B', effect: 0.1, sig: false }], pse: 0.5 }), /^效应正态概率图 · 2 个效应项，显著：A$/],
    ['效应半正态(空)', createElement(EffectsNormalPlot, { T, terms: [], pse: 0, half: true }), /^效应半正态概率图（无可估计效应）$/],
    ['OC 二项', createElement(OcCurveChart, { T, n: 50, ac: 1 }), /^OC 特性曲线（二项）· n=50，Ac=1$/],
    ['OC 每百', createElement(OcCurvePer100, { T, plan: { code: 'H', n: 50, ac: 1, re: 2 }, aql: 1 }), /^OC 特性曲线（每百单位不合格数，泊松）· n=50，Ac=1$/],
    ['散点', createElement(ScatterPlot, { T, xs: [1, 2, 3], ys: [2, 4, 7], slope: 2, intercept: 0, xLabel: '温度', yLabel: '硬度' }), /^散点图 · 硬度 对 温度$/],
    ['散点(空)', createElement(ScatterPlot, { T, xs: [], ys: [], slope: 0, intercept: 0, xLabel: '拟合值', yLabel: '残差' }), /^散点图 · 残差 对 拟合值（无有效数据）$/],
    ['帕累托', createElement(ParetoChart, { T, rows: [{ name: '划伤', count: 5 }, { name: '凹坑', count: 2 }], title: '缺陷 的 Pareto 图' }), /^缺陷 的 Pareto 图$/],
    ['帕累托(无标题)', createElement(ParetoChart, { T, rows: [{ name: '划伤', count: 5 }] }), /^帕累托图$/],
    ['变异分量', createElement(GroupedBars, { T, cats: [{ name: '重复性', contrib: 10, study: 30, tol: 20 }] }), /^量具 R&R 变异分量图 · 1 个分量/],
    ['箱线图', createElement(BoxPlot, { T, groups: [{ name: '直径', vals: [1, 2, 3, 4, 5] }] }), /^箱线图 · 直径$/],
    ['个体值', createElement(IndividualValuePlot, { T, groups: [{ name: '甲', vals: [1, 2] }, { name: '乙', vals: [3, 4] }] }), /^个体值图 · 甲、乙$/],
    ['区间图', createElement(IntervalPlot, { T, groups: [{ name: '甲', vals: [1, 2, 3] }, { name: '乙', vals: [3, 4, 5] }] }), /^均值与 95% 置信区间 · 甲、乙$/],
    ['直方图', createElement(MiniHist, { T, data: [1, 2, 3, 4], xLabel: '残差分布' }), /^直方图 · 残差分布$/],
    ['直方图(空)', createElement(MiniHist, { T, data: [], title: '标准化残差分布' }), /^直方图 · 标准化残差分布（无有效数据）$/],
  ];
  for (const [name, element, expected] of cases) {
    it(`${name}:具体名称，且不以 role="img" 遮蔽图内读数`, () => {
      const markup = renderToStaticMarkup(element);
      expect(markup, '夹具缺 props 产生 NaN 几何').not.toMatch(/="[^"]*NaN/);
      const label = ariaLabelOf(markup);
      expect(label).toMatch(expected);
      expect(label).not.toBe('统计图表');
      expect(markup).toContain('role="group"');
    });
  }

  it('源码守卫：src/ui 非测试源码的每个 <Svg> 都传 label(含 gagePanels.tsx)', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : walk(path);
      return path.endsWith('.tsx') ? [path] : [];
    });
    const files = walk('src/ui');
    const missing: string[] = [];
    for (const path of files) {
      const source = readFileSync(path, 'utf8');
      let at = source.indexOf('<Svg');
      while (at >= 0) {
        // 括号深度扫描取完整开标签(属性值里可能含 => 与 >)
        let depth = 0;
        let end = at + 4;
        for (; end < source.length; end++) {
          const ch = source[end];
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          else if (ch === '>' && depth === 0) break;
        }
        const tag = source.slice(at, end);
        if (/^<Svg[\s>]/.test(source.slice(at, at + 5)) && !/\blabel=/.test(tag)) {
          missing.push(`${path}:${source.slice(0, at).split('\n').length}`);
        }
        at = source.indexOf('<Svg', end);
      }
    }
    expect(missing, `以下 <Svg> 未传具体名称:${missing.join('、')}`).toEqual([]);
  });

  it('渲染主要页面后，每张图都有具体名称(不存在无名或通用「统计图表」的图)', () => {
    const pages = ['质量总览', '描述性统计', '控制图 (SPC)', '过程能力分析', '测量系统分析', '假设检验 / ANOVA', '帕累托图', '实验设计 (DOE)', '抽样检验 (AQL)'];
    const offenders: string[] = [];
    let checked = 0;
    for (const nav of pages) {
      cleanup();
      const { container } = render(<App />);
      fireEvent.click(screen.getAllByText(nav)[0]);
      const demo = screen.queryByText('查看示例数据');
      if (demo) fireEvent.click(demo);
      // fix2611b B2:不只查 svg[data-qp-chart]——凡含图形标记、非图标尺寸(viewBox 宽 > 60)且未
      // aria-hidden 的 svg 都算统计图(描述性统计页箱线图曾是裸 <svg>,旧守卫漏掉)。
      const charts = [...container.querySelectorAll('svg')].filter((svg) => {
        if (svg.closest('[aria-hidden="true"]')) return false;
        if (!svg.querySelector('path, rect, circle, line, polyline, polygon')) return false;
        const width = Number((svg.getAttribute('viewBox') ?? '').split(/\s+/)[2] ?? svg.getAttribute('width') ?? 0);
        return width > 60;
      });
      checked += charts.length;
      charts.forEach((svg, index) => {
        const label = svg.getAttribute('aria-label')?.trim();
        if (!label || label === '统计图表') offenders.push(`${nav}#${index}(viewBox ${svg.getAttribute('viewBox')})`);
      });
    }
    expect(checked, '页面上未找到任何统计图').toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });

  it('鱼骨图带具体名称(含问题描述)', () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getAllByText('帕累托图')[0]);
    fireEvent.click(screen.getByText('鱼骨图（因果分析）'));
    const fishbone = [...container.querySelectorAll('svg[data-qp-chart]')]
      .find((svg) => /^鱼骨图（6M 因果图）· 问题：/.test(svg.getAttribute('aria-label') ?? ''));
    expect(fishbone, '鱼骨图未带具体名称').toBeTruthy();
  });
});
