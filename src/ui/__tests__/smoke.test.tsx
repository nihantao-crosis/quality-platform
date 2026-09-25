/**
 * UI 冒烟测试（jsdom）— 九页渲染、导航、导入数据流、主题切换。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import App from '../../App';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  // fix2609 TESTS-02 同类残留:t 检验用例改 hypoTab/t 列、P 图剪贴板用例改 importKind、
  // 主题用例改 chartStyle,不复位则乱序时 ANOVA 页找不到「方差分析表」、剪贴板按 P 图口径导入失败。
  useApp.setState({
    page: 'dashboard', modal: null, openMenu: null, toast: null, spcType: 'xbar-r', selSub: null, lsl: 24.9, tgt: 25.0, usl: 25.1,
    hypoTab: 'anova', t1ColName: null, t1Mu0: null, t2ColAName: null, t2ColBName: null,
    importTab: 'csv', importKind: 'var', chartStyle: '经典',
  });
  cancelPendingDatasetWork();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
});

describe('九页渲染冒烟', () => {
  const pages: Array<[string, string]> = [
    ['质量总览', '过程均值趋势'],
    ['数据工作表', '数据来源'],
    ['控制图 (SPC)', '控制限与参数'],
    ['过程能力分析', '能力评估'],
    ['测量系统分析', '系统评定'],
    ['假设检验 / ANOVA', '方差分析表'],
    ['帕累托图', '缺陷明细'],
    ['实验设计 (DOE)', '结论与优化'],
    ['抽样检验 (AQL)', '风险指标'],
  ];
  for (const [nav, marker] of pages) {
    it(`${nav} 页渲染`, () => {
      render(<App />);
      fireEvent.click(screen.getAllByText(nav)[0]);
      // 数据契约:无可分析数据的页面先显示空态卡,点「查看示例数据」进入示例
      const demoBtn = screen.queryByText('查看示例数据');
      if (demoBtn) fireEvent.click(demoBtn);
      expect(screen.getAllByText(new RegExp(marker)).length).toBeGreaterThan(0);
    });
  }
});

describe('数据流冒烟', () => {
  it('剪贴板导入成功后自动关闭弹窗并显示新工作表', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('导入 CSV/Excel'));
    fireEvent.click(screen.getByText('剪贴板粘贴'));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '子组,测量1,测量2\n1,10,11\n2,12,13\n3,14,15' },
    });
    fireEvent.click(screen.getByText('导入', { exact: true }));
    await waitFor(() => expect(useApp.getState().modal).toBeNull());
    expect(useApp.getState()).toMatchObject({ modal: null, page: 'worksheet' });
    expect(useData.getState().model.name).toBe('剪贴板数据');
    expect(screen.queryByText('导入数据')).toBeNull();
    expect(screen.getAllByText(/剪贴板数据/).length).toBeGreaterThan(0);
  });

  it('导入变量数据 → 状态栏/工作表跟随,恢复演示可回退', () => {
    render(<App />);
    act(() => useData.getState().importMatrix('冒烟.csv', ['a', 'b'], [[1, 2], [2, 3], [3, 4]]));
    expect(useData.getState().model.name).toBe('冒烟.csv');
    expect(screen.getAllByText(/冒烟\.csv/).length).toBeGreaterThan(0);
    act(() => useData.getState().resetDemo());
    expect(useData.getState().model.name).toBe('质检数据.mtw');
  });
  it('导入计数数据 → P 图模型替换并切到 SPC', () => {
    render(<App />);
    act(() => useData.getState().importCounts('p', '产线不良.csv', [1, 2, 0, 3, 1], 40));
    expect(useData.getState().pModel.isDemo).toBe(false);
    expect(useApp.getState().spcType).toBe('p');
  });
  it('P 图逐批样本量持久化并在页面显示变控制限', () => {
    act(() => useData.getState().importCounts('p', '变样本量.csv', [1, 2, 3], [10, 20, 30]));
    useApp.setState({ page: 'spc', spcType: 'p' });
    render(<App />);
    expect(screen.getAllByText(/样本量 n = 10–30（逐批变化）/).length).toBeGreaterThan(0);
    expect(screen.getByText('UCL 范围')).toBeTruthy();
    expect(screen.getByText('LCL 范围')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('qp-attr-v1') ?? '{}').p).toMatchObject({
      counts: [1, 2, 3], sampleSizes: [10, 20, 30],
    });
  });
  it('P 图剪贴板两列导入按“不良数,每批样本量”解释', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('导入 CSV/Excel'));
    fireEvent.click(screen.getByText('剪贴板粘贴'));
    fireEvent.click(screen.getByText('不良数（P 图）'));
    // G13:P 图默认 n 改为 type=text 后也是 textbox,按占位符定位粘贴框
    fireEvent.change(screen.getByPlaceholderText(/将数据粘贴到此处/), {
      target: { value: '不良数,每批样本量\n1,10\n4,40\n2,20' },
    });
    fireEvent.click(screen.getByText('导入', { exact: true }));
    await waitFor(() => expect(useApp.getState().modal).toBeNull());
    expect(useApp.getState()).toMatchObject({ modal: null, page: 'spc', spcType: 'p' });
    expect(useData.getState().pModel.pdef).toEqual([1, 4, 2]);
    expect(useData.getState().pModel.pNs).toEqual([10, 40, 20]);
    expect(useData.getState().pModel.pVariableN).toBe(true);
  });
  it('EWMA/CUSUM 图型可切换', () => {
    render(<App />);
    fireEvent.click(screen.getAllByText('控制图 (SPC)')[0]);
    fireEvent.click(screen.getByText('EWMA'));
    expect(screen.getAllByText(/指数加权移动平均/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('CUSUM'));
    expect(screen.getAllByText(/累积和/).length).toBeGreaterThan(0);
  });
  it('主题循环切换', () => {
    render(<App />);
    const label = screen.getByText(/图表风格: 经典/);
    fireEvent.click(label);
    expect(screen.getByText(/图表风格: 现代/)).toBeTruthy();
  });

  it('t 检验遇到零标准误时显示未运行，不抛出页面错误或伪 P 值', () => {
    useData.getState().importMatrix('常量样本.csv', ['常量A', '常量B'], [[5, 9], [5, 9], [5, 9], [5, 9]]);
    useApp.setState({ page: 'anova', hypoTab: 't1', t1ColName: '常量A', t1Mu0: 0 });
    const view = render(<App />);
    expect(view.container.textContent).toContain('分析未运行');
    expect(view.container.textContent).toContain('标准误为 0 或不可估计');
    expect(view.container.textContent).not.toContain('P = 0.000');

    act(() => useApp.setState({ hypoTab: 't2', t2ColAName: '常量A', t2ColBName: '常量B' }));
    expect(view.container.textContent).toContain('分析未运行');
    expect(view.container.textContent).toContain('双样本 t 检验标准误为 0');
  });
});
