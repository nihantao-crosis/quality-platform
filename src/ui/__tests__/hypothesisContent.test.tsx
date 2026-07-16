/** 假设检验页面、专项导出与帮助文案的内容安全回归。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { chartTokens } from '../tokens';
import { Anova } from '../pages/SimplePages';
import { HelpModal } from '../shell/HelpModal';
import { MenuBar } from '../shell/MenuBar';

const T = chartTokens('经典', true);

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'anova', modal: null, openMenu: null, toast: null,
    hypoTab: 't2', t1ColName: null, t1Mu0: null,
    t2ColAName: null, t2ColBName: null, regXName: null, regYName: null,
    anovaMode: 'stacked', anovaRespName: null, anovaFactorName: null, anovaShowDemo: false,
  });
});

describe('真实数据的假设检验内容安全', () => {
  it('单数值列的双样本 t 在页面和专项导出中明确未运行，不换用设备演示样本', () => {
    useData.getState().importMatrix('真实单列.csv', ['强度'], [[9], [10], [11], [10]]);
    useApp.setState({ page: 'anova', hypoTab: 't2' });

    const view = render(<Anova T={T} />);
    const text = view.container.textContent ?? '';
    expect(text).toContain('分析未运行');
    expect(text).toContain('需要两个不同的数值样本列');
    expect(text).toContain('系统不会改用内置演示数据');
    expect(text).not.toContain('设备 A');
    expect(text).not.toContain('设备 B');

    const report = buildActiveAnalysisReport();
    expect(report).toMatchObject({ kind: 't2', usesWorksheet: true, tables: [], charts: [] });
    expect(report?.summary.join(' ')).toContain('当前分析未运行');
    expect(report?.warnings.join(' ')).toContain('需要两个不同的数值样本列');
    expect(report?.warnings.join(' ')).toContain('不会改用内置演示数据');
  });

  it('不显著结果只表述证据不足，不宣称对准、等效、同一总体或独立', () => {
    useData.getState().importMatrix('单样本.csv', ['样本'], [[9], [10], [11], [10]]);
    useApp.setState({ hypoTab: 't1', t1ColName: '样本', t1Mu0: 10 });
    let view = render(<Anova T={T} />);
    expect(view.container.textContent).toContain('不等于过程已对准目标');
    expect(view.container.textContent).not.toContain('过程中心可视为对准目标');
    expect(buildActiveAnalysisReport()?.summary.join(' ')).toContain('不等于过程已对准目标');
    cleanup();

    useData.getState().importMatrix('双样本.csv', ['A', 'B'], [[1, 1.1], [2, 2.1], [3, 3.1], [4, 4.1]]);
    useApp.setState({ hypoTab: 't2', t2ColAName: 'A', t2ColBName: 'B' });
    view = render(<Anova T={T} />);
    expect(view.container.textContent).toContain('不等于两组均值相同或等效');
    expect(buildActiveAnalysisReport()?.summary.join(' ')).toContain('不等于两组均值相同或等效');
    cleanup();

    useData.getState().importMatrix('回归.csv', ['X', 'Y'], [[1, 1], [2, 2], [3, 2], [4, 1]]);
    useApp.setState({ hypoTab: 'reg', regXName: 'X', regYName: 'Y' });
    view = render(<Anova T={T} />);
    expect(view.container.textContent).toContain('不等于两列相互独立');
    expect(view.container.textContent).not.toContain('通常独立');
    expect(buildActiveAnalysisReport()?.summary.join(' ')).toContain('不等于 X 与 Y 相互独立');
    cleanup();

    useData.getState().importMatrix(
      'ANOVA.csv',
      ['响应'],
      [[1], [2], [3], [1.1], [2.1], [3.1]],
      [{ name: '组别', values: ['A', 'A', 'A', 'B', 'B', 'B'] }],
    );
    useApp.setState({ hypoTab: 'anova', anovaMode: 'stacked', anovaRespName: '响应', anovaFactorName: '组别' });
    view = render(<Anova T={T} />);
    expect(view.container.textContent).toContain('不等于各组均值相同、等效或来自同一总体');
    expect(view.container.textContent).not.toContain('可视为同一总体');
    expect(buildActiveAnalysisReport()?.summary.join(' ')).toContain('不等于各组均值相同、等效或来自同一总体');
  });
});

describe('帮助和更新提示', () => {
  it('帮助说明 P 图逐批 nᵢ 和 Gage 文本/数值 ID 类别列', () => {
    render(<HelpModal onClose={() => undefined} />);
    expect(screen.getByText(/p̄=Σdᵢ\/Σnᵢ/)).toBeTruthy();
    expect(screen.getByText(/按每批 nᵢ 计算各点控制限/)).toBeTruthy();

    fireEvent.click(screen.getAllByText('测量系统分析 Gage R&R')[0]);
    expect(screen.getByText(/类别可使用文本编码或数值 ID/)).toBeTruthy();
  });

  it('Web 更新提示承认离线缓存，不再声称始终为最新', () => {
    render(<MenuBar wsName="测试工作表" />);
    fireEvent.click(screen.getByText('帮助'));
    fireEvent.click(screen.getByText('检查更新…'));
    expect(useApp.getState().toast).toContain('离线时可能继续使用本地缓存');
    expect(useApp.getState().toast).not.toContain('始终为最新版本');
  });
});
