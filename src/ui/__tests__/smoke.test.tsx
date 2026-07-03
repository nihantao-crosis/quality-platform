/**
 * UI 冒烟测试（jsdom）— 九页渲染、导航、导入数据流、主题切换。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import App from '../../App';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useApp.setState({ page: 'dashboard', modal: null, openMenu: null, toast: null, spcType: 'xbar-r', selSub: null, lsl: 24.9, tgt: 25.0, usl: 25.1 });
  useData.getState().resetDemo();
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
      expect(screen.getAllByText(new RegExp(marker)).length).toBeGreaterThan(0);
    });
  }
});

describe('数据流冒烟', () => {
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
});
