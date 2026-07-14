/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { parseCategoryCounts } from '../../core';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Pareto } from '../pages/SimplePages';
import { chartTokens } from '../tokens';

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    paretoView: 'pareto', paretoMergeOther: true, paretoThreshold: 0.95, paretoShowDemo: false,
  });
});

describe('人工反馈帕累托完整流程', () => {
  it('横向两行粘贴可导入、降序出图、显示柱值/累计百分比/95%设置', () => {
    const parsed = parseCategoryCounts('不良A\t不良B\t不良C\t不良D\t不良E\t不良F\n35\t15\t36\t68\t30\t65');
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.note).toContain('自动转置');
    useData.getState().importPareto('黄广洋帕累托样例', parsed.rows);
    const html = render(createElement(Pareto, { T: chartTokens('经典', true) })).container.innerHTML;

    expect(html).toContain('缺陷帕累托图 · 黄广洋帕累托样例');
    expect(html).toContain('合并尾部为「其他」');
    expect(html).toContain('aria-label="合并其他累计阈值"');
    expect(html).toContain('value="95"');
    expect(html).toContain('频数');
    expect(html).toContain('累计百分比');
    expect(html).toContain('缺陷 / 原因类别（按频数降序）');
    // PPT 的 6 个柱值与最终累计 100% 均进入 SVG/明细。
    for (const count of [68, 65, 36, 35, 30, 15]) expect(html).toContain(`>${count}</text>`);
    expect(html).toContain('>100%</text>');
    expect(html.indexOf('不良D')).toBeLessThan(html.indexOf('不良F'));
    expect(html.indexOf('不良F')).toBeLessThan(html.indexOf('不良C'));
  });
});
