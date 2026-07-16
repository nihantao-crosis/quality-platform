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
  it('横向两行粘贴可导入、降序出图、经典主题按 Minitab 出统计表与标题', () => {
    const parsed = parseCategoryCounts('不良A\t不良B\t不良C\t不良D\t不良E\t不良F\n35\t15\t36\t68\t30\t65');
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.note).toContain('自动转置');
    useData.getState().importPareto('黄广洋帕累托样例', parsed.rows);
    const html = render(createElement(Pareto, { T: chartTokens('经典', true) })).container.innerHTML;

    expect(html).toContain('缺陷帕累托图 · 黄广洋帕累托样例');
    expect(html).toContain('合并尾部为「其他」');
    expect(html).toContain('aria-label="合并其他累计阈值"');
    expect(html).toContain('value="95"');
    // 批次P(人工反馈716):经典主题 Minitab 化——标题「〈列名〉 的 Pareto 图」、
    // 底部 类别/频数/百分比/累积% 统计表、统一钢蓝柱含描边、深蓝累积线、左轴量程=累计总数
    expect(html).toContain('黄广洋帕累托样例 的 Pareto 图');
    for (const rowLabel of ['类别', '频数', '百分比', '累积%']) expect(html).toContain(`>${rowLabel}</text>`);
    expect(html).toContain('stroke="#2A4B8D"');
    expect(html).toContain('stroke="#1F3864"');
    expect(html).toContain('>249</text>'); // 左轴顶=总数 249
    expect(html).not.toContain('>27%</text>'); // 累积线不再逐点标百分比(明细表仍有 27%)
    // PPT 的 6 个柱值与最终累计 100% 均进入统计表/明细。
    for (const count of [68, 65, 36, 35, 30, 15]) expect(html).toContain(`>${count}</text>`);
    expect(html.indexOf('不良D')).toBeLessThan(html.indexOf('不良F'));
    expect(html.indexOf('不良F')).toBeLessThan(html.indexOf('不良C'));
  });

  it('非经典主题保持原布局(轴标题+逐点百分比,不出统计表)', () => {
    const parsed = parseCategoryCounts('不良A\t不良B\t不良C\t不良D\t不良E\t不良F\n35\t15\t36\t68\t30\t65');
    if ('error' in parsed) throw new Error(parsed.error);
    useData.getState().importPareto('黄广洋帕累托样例', parsed.rows);
    const html = render(createElement(Pareto, { T: chartTokens('现代', true) })).container.innerHTML;
    expect(html).toContain('累计百分比');
    expect(html).toContain('缺陷 / 原因类别（按频数降序）');
    expect(html).not.toContain('的 Pareto 图');
  });
});
