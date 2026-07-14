/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { Worksheet } from '../pages/Worksheet';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null,
    spcStageCol: null, selSub: null,
  });
});

describe('工作表与 SPC 数据角色一致', () => {
  it('人工反馈样例的均值/极差和列统计排除数值子组列', () => {
    useData.getState().importMatrix('黄广洋样例.csv', ['子组', '直径1', '直径2', '直径3', '直径4', '直径5'], [
      [1, 4.5, 10.1, 13.5, 11.0, 11.1],
      [2, 8.1, 10.7, 5.8, 3.1, 8.7],
      [3, 11.1, 4.7, 11.6, 3.8, 10.4],
    ]);

    const html = render(createElement(Worksheet)).container.innerHTML;
    expect(html).toContain('列统计 · 直径');
    expect(html).toContain('10.040'); // 第 1 行的 5 次直径均值
    expect(html).not.toContain('8.533'); // 若错把子组 ID=1 混入，才会得到该值
    expect(html).toContain('>15<'); // 3 子组 × 5 次真实测量
  });
});
