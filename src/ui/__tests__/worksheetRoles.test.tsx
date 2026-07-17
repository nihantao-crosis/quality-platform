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

// ================= 批次716-R3 P1-1:删除重复的 ID/行 数据列(人工审核 PPT 10 页) =================

describe('Minitab 式行号槽:无重复的 ID/行 数据列', () => {
  it('三列(部件/测试人/螺钉高度)导入后,数据列表头恰为这 3 个 + 行号槽,不存在第二个行号列', () => {
    useData.getState().importMatrix('工厂GRR', ['部件', '螺钉高度'],
      [[1, 10.1], [2, 10.2], [3, 10.0]],
      [{ name: '测试人', values: ['邹德玉', '邹德玉', '邹德玉'], sourceIndex: 1 }]);
    const { container } = render(createElement(Worksheet));

    const headerRows = container.querySelectorAll('thead tr');
    // 代号行:行号槽无代号,数据列为 C1/T1/C2(不再有 ID)
    const codes = [...headerRows[0].querySelectorAll('th')].map((th) => th.textContent);
    expect(codes).toEqual(['', 'C1', 'T1', 'C2']);
    // 列名行:行号槽无标题(Minitab 式),数据列按导入原序恰为 3 个(测量列名后缀的 × 是删列按钮)
    const names = [...headerRows[1].querySelectorAll('th')].map((th) => th.textContent?.replace(/×$/, ''));
    expect(names).toEqual(['', '部件', '测试人', '螺钉高度']);
    expect(container.innerHTML).not.toContain('>行</th>');

    // 每行 = 1 个 sticky 行号槽 + 3 个数据单元格,没有第二个行号单元格
    const firstRow = container.querySelector('tbody tr')!;
    const cells = [...firstRow.querySelectorAll('td')];
    expect(cells).toHaveLength(4);
    expect(cells[0].className).toContain('ws-rownum');
    expect(cells.slice(1).map((td) => td.textContent)).toEqual(['1', '邹德玉', '10.100']);
    // 删行按钮仍在行号槽内
    expect(firstRow.querySelector('.ws-rownum .ws-del')).not.toBeNull();
  });

  it('行式子组数据集(演示集)行号槽保留「子组」语义,均值/极差列仍在', () => {
    // beforeEach 已 resetDemo:演示集为行式子组口径
    const { container } = render(createElement(Worksheet));
    const names = [...container.querySelectorAll('thead tr')[1].querySelectorAll('th')].map((th) => th.textContent);
    expect(names[0]).toBe('子组'); // 行号槽表头承载子组语义
    expect(names.filter((name) => name === '子组')).toHaveLength(1); // 不再有第二个「子组/ID」数据列
    expect(names).toContain('均值');
    expect(names).toContain('极差');
    // 行号槽本身仍显示序号
    expect(container.querySelector('tbody tr .ws-rownum .ws-num')?.textContent).toBe('1');
  });
});
