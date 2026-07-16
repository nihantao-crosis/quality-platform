/** 描述性统计单变量口径、专项导出与外壳状态回归。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import App from '../../App';
import { buildActiveAnalysisExport, buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Summary } from '../pages/Summary';
import { chartTokens } from '../tokens';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'summary', activeVar: '', modal: null, toast: null,
    lsl: 0, usl: 100, lslOn: true, uslOn: true,
    gageUseReal: true, gageValueName: null, gagePartName: null, gageOperatorName: null,
  });
});

describe('描述性统计单变量口径', () => {
  it('不同量纲列不会再展平混算，变量选择同时驱动页面和专项导出', () => {
    useData.getState().importMatrix('工艺.csv', ['温度', '压力', '速度'], [
      [20, 100, 1], [22, 200, 2], [24, 300, 3],
    ]);
    useApp.setState({ activeVar: '压力' });
    const view = render(createElement(Summary, { T: chartTokens('经典', true) }));
    expect((view.getByLabelText('描述性统计变量') as HTMLSelectElement).value).toBe('压力');
    expect(view.container.textContent).toContain('变量：压力（3 个观测）');
    expect(view.container.textContent).toContain('200.000');
    expect(view.container.textContent).not.toContain('74.667');

    fireEvent.change(view.getByLabelText('描述性统计变量'), { target: { value: '速度' } });
    expect(useApp.getState().activeVar).toBe('速度');
    expect(view.container.textContent).toContain('变量：速度（3 个观测）');

    const report = buildActiveAnalysisReport();
    expect(report).toMatchObject({ kind: 'summary', usesWorksheet: true });
    expect(report?.subtitle).toContain('速度');
    expect(report?.tables.find((table) => table.title === '用于汇总的原始观测')?.rows).toHaveLength(3);
    const exported = buildActiveAnalysisExport();
    expect(exported.model.colNames).toEqual(['速度']);
    expect(exported.model.all).toEqual([1, 2, 3]);
  });

  it('所选列含待录入值时阻断汇总，常量列图形不输出 NaN', () => {
    useData.getState().importMatrix('待录入.csv', ['测量值'], [[5], [5], [5]], [], [{ row: 1, col: 0 }]);
    const blocked = render(createElement(Summary, { T: chartTokens('经典', true) }));
    expect(blocked.container.textContent).toContain('描述性统计尚未运行');
    expect(blocked.container.textContent).toContain('1 个待录入单元格');
    cleanup();

    useData.getState().importMatrix('常量.csv', ['测量值'], [[5], [5], [5], [5], [5], [5], [5], [5]]);
    const constant = render(createElement(Summary, { T: chartTokens('经典', true) }));
    expect(constant.container.innerHTML).not.toContain('NaN');
  });
});

describe('外壳真实状态', () => {
  it('非 Gage 工作表不显示内置 9.0%，演示研究明确标注', () => {
    useData.getState().importMatrix('普通.csv', ['测量值'], [[1], [2], [3]]);
    useApp.setState({ page: 'dashboard', gageUseReal: true });
    const real = render(<App />);
    expect(real.container.textContent).toContain('Gage R&R —');
    cleanup();

    useData.getState().resetDemo();
    useApp.setState({ page: 'dashboard' });
    const demo = render(<App />);
    expect(demo.container.textContent).toContain('Gage R&R 8.8%（演示）');
  });

  it('工作表和 SPC 标题跟随真实数据集及图型', () => {
    useData.getState().importMatrix('批次甲.csv', ['测量1', '测量2'], [[1, 2], [2, 3], [3, 4]]);
    useApp.setState({ page: 'worksheet' });
    const view = render(<App />);
    expect(view.container.textContent).toContain('数据工作表 · 批次甲.csv');
    fireEvent.click(view.getAllByText('控制图 (SPC)')[0]);
    fireEvent.click(view.getByText('I-MR'));
    expect(view.container.textContent).toContain('SPC 控制图 · I-MR');
  });
});
