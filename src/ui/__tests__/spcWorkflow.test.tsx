/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Spc } from '../pages/Spc';
import { Dashboard } from '../pages/Dashboard';
import { chartTokens } from '../tokens';
import { DEFAULT_RULE_K } from '../../core';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';

const RULES = { r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false };

function renderSpc() {
  return render(createElement(Spc, { T: chartTokens('经典', true) })).container.innerHTML;
}

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    spcType: 'xbar-r', spcRules: { ...RULES }, spcDataLayout: 'auto',
    spcValueCol: null, spcSubgroupCol: null, spcStageCol: null, selSub: null,
    lsl: 0, tgt: 1000, usl: 2000, lslOn: true, uslOn: true,
  });
});

describe('SPC 页面端到端数据角色', () => {
  it('人工反馈样例不再把数值子组列算成第 6 次测量', () => {
    useData.getState().importMatrix('黄广洋样例.csv', ['子组', '直径1', '直径2', '直径3', '直径4', '直径5'], [
      [1, 4.5, 10.1, 13.5, 11.0, 11.1],
      [2, 8.1, 10.7, 5.8, 3.1, 8.7],
      [3, 11.1, 4.7, 11.6, 3.8, 10.4],
    ]);
    const html = renderSpc();
    expect(html).toContain('自动识别为「行式子组（一行一个子组）」');
    expect(html).toContain('3 个子组 × 5 次组内测量');
    expect(html).toContain('「子组」仅作子组标签，未参与测量计算');
    expect(html).toContain('变量：直径');
    expect(html).toContain('子组大小 n = 5');
    expect(html).not.toContain('子组大小 n = 6');
    // 批次716-R3:X̄ 与 R 合并为上下双面板单标题(人工反馈716 PPT 第4页)
    expect(html).toContain('直径 的 Xbar-R 控制图');
    expect(html).toContain('直径 · 子组均值');
    expect(html).toContain('直径 · 子组极差');
    expect(html).toContain('判读顺序：先看 R 图');
  });

  it('仪表盘与 SPC 页共用角色口径，不在首页重新把子组列混入测量', () => {
    useData.getState().importMatrix('黄广洋样例.csv', ['子组', '直径1', '直径2', '直径3', '直径4', '直径5'], [
      [1, 4.5, 10.1, 13.5, 11.0, 11.1],
      [2, 8.1, 10.7, 5.8, 3.1, 8.7],
      [3, 11.1, 4.7, 11.6, 3.8, 10.4],
    ]);
    const html = render(createElement(Dashboard, { T: chartTokens('经典', true) })).container.innerHTML;
    expect(html).toContain('过程均值趋势 · 直径');
    expect(html).toContain('3 子组');
    expect(html).toContain('直径 · 子组均值');
    expect(html).not.toContain('SPC 数据角色存在歧义');
  });

  it('R-only 失控时页面、结论卡和列表都先报 R，明确暂不解释 X̄', () => {
    const rows = Array.from({ length: 24 }, () => [9, 11]);
    rows.push([0, 20]); // 均值仍为 10，只有极差失控
    useData.getState().importMatrix('R-only.csv', ['直径1', '直径2'], rows);
    useApp.setState({ spcRules: { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false } });

    const html = renderSpc();

    expect(html).toContain('R 图先检出 1 个异常点');
    expect(html).toContain('过程变异尚未受控');
    expect(html).toContain('暂不解释其信号');
    expect(html).toContain('R 图 · 子组 25 · 准则 1');
    expect(html).toContain('共 1 个失控点 · 1 个点-准则命中');
  });

  it('分阶段自定义 K2=12 时图上红点、结论卡与明细都按 24 个实际点', () => {
    // 每阶段均值 12/13：首点 0 低于中心线，随后 12 点连续高于中心线。
    // core/图每段标 12 点，若消费层错用默认 K2=9，则每段只展开 9 点（合计 18）。
    const stage = [0, ...Array(12).fill(1)] as number[];
    const values = [...stage, ...stage];
    useData.getState().importMatrix(
      '分阶段自定义K.csv', ['x1', 'x2'], values.map((value) => [value, value]),
      [{ name: '阶段', values: [...Array(13).fill('A'), ...Array(13).fill('B')] }],
    );
    useApp.setState({
      spcType: 'xbar-r', spcDataLayout: 'rows', spcStageCol: '阶段',
      spcRules: { r1: false, r2: true, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false },
      spcRuleK: { ...DEFAULT_RULE_K, k2: 12 },
    });

    const tokens = chartTokens('经典', true);
    const view = render(createElement(Spc, { T: tokens }));
    const text = view.container.textContent ?? '';
    expect(view.container.querySelectorAll(`circle[fill="${tokens.limit}"]`)).toHaveLength(24);
    expect(text).toContain('X̄-R 检测到 24 个失控点');
    expect(text).toContain('共 24 个失控点 · 24 个点-准则命中');
    expect(text).toContain('连续 12 点落在中心线同一侧');
  });

  it('数值 ID 堆叠格式自动分组，并在横轴显示实际子组 ID', () => {
    useData.getState().importMatrix('堆叠.csv', ['子组', '压入力'], [
      [101, 500], [101, 520], [102, 600], [102, 640],
    ]);
    const html = renderSpc();
    expect(html).toContain('自动识别为「堆叠格式（测量值 + 子组 ID）」');
    expect(html).toContain('「压入力」作为测量值');
    expect(html).toContain('「子组」作为子组 ID');
    expect(html).toContain('子组（子组）');
    expect(html).toContain('101');
    expect(html).toContain('102');
  });

  it('多候选测量列时显示阻断错误，不回退到混算控制图', () => {
    useData.getState().importMatrix('歧义.csv', ['子组', '直径', '温度'], [
      [1, 10, 20], [1, 11, 21], [2, 12, 22], [2, 13, 23],
    ]);
    const html = renderSpc();
    expect(html).toContain('控制图未运行');
    expect(html).toContain('请选择哪一列是测量值');
    expect(html).toContain('不会回退到“把所有数值列都当测量值”的旧口径');
  });

  it('切换工作表会清除上一张表的 SPC 布局、列角色和阶段，不跨物理量静默混算', () => {
    useData.getState().importMatrix(
      '旧尺寸.csv', ['直径1', '直径2'], [[10, 11], [12, 13]],
      [{ name: '阶段', values: ['基线', '改善'] }],
    );
    useApp.setState({
      spcDataLayout: 'rows', spcValueCol: '直径1', spcSubgroupCol: null, spcStageCol: '阶段', selSub: 1,
    });

    useData.getState().importMatrix('新工艺.csv', ['温度', '压力'], [[100, 5], [110, 6], [120, 7]]);

    expect(useApp.getState()).toMatchObject({
      spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null, selSub: null,
    });
    const html = renderSpc();
    expect(html).toContain('控制图未运行');
    expect(html).toContain('多个名称不同的业务数值列');
    expect(html).not.toContain('分阶段未运行');
  });

  it('从 P/C 属性数据切回变量工作表时退出旧属性图', () => {
    useData.getState().importCounts('p', '旧P图', [1, 2, 0], [50, 100, 40]);
    expect(useApp.getState().spcType).toBe('p');

    useData.getState().importMatrix('新变量.csv', ['直径1', '直径2'], [[10, 11], [12, 13], [11, 12]]);
    expect(useApp.getState().spcType).toBe('xbar-r');
    const html = renderSpc();
    expect(html).toContain('变量：直径');
    expect(html).not.toContain('旧P图');
  });

  it('多候选测量列时仪表盘的 Cpk/PPM 也保持待配置，不用原始混列数据计算', () => {
    useData.getState().importMatrix('歧义.csv', ['子组', '直径', '温度'], [
      [1, 10, 20], [1, 11, 21], [2, 12, 22], [2, 13, 23],
    ]);
    const html = render(createElement(Dashboard, { T: chartTokens('经典', true) })).container.innerHTML;
    expect(html).toContain('SPC 数据角色存在歧义');
    expect(html).toContain('过程能力 Cpk');
    expect(html).toContain('请选择哪一列是测量值');
    expect(html).toContain('不良 PPM');
    expect(html).toContain('未运行');
  });

  it('不同物理量列自动阻断 SPC/能力混算，选择响应后才按单值分析', () => {
    useData.getState().importMatrix('压装 DOE.csv', ['过盈量', '轴硬度', '压入力'], [
      [0.045, 28, 970], [0.09, 32, 940], [0.0675, 30, 980], [0.0675, 30, 690],
      [0.045, 32, 1380], [0.09, 28, 1180], [0.0675, 30, 530],
    ]);
    const blocked = render(createElement(Dashboard, { T: chartTokens('经典', true) }));
    expect(blocked.container.textContent).toContain('多个名称不同的业务数值列');
    expect(blocked.getByText('过程能力 Cpk').parentElement?.textContent).toContain('—');
    cleanup();

    useApp.setState({ spcValueCol: '压入力' });
    const spc = render(createElement(Spc, { T: chartTokens('经典', true) }));
    expect(spc.container.textContent).toContain('自动识别为「单值列（I-MR）」');
    expect(spc.container.textContent).toContain('仅使用「压入力」的 7 个观测');
  });

  it('DOE 存储输出写回后不污染已选 SPC/能力测量口径', () => {
    useData.getState().importMatrix('压装 DOE.csv', ['过盈量', '轴硬度', '压入力'], [
      [0.045, 28, 970], [0.09, 32, 940], [0.0675, 30, 980], [0.0675, 30, 690],
      [0.045, 32, 1380], [0.09, 28, 1180], [0.0675, 30, 530],
    ]);
    useApp.setState({ spcValueCol: '压入力' });
    const beforeView = render(createElement(Dashboard, { T: chartTokens('经典', true) }));
    const beforeCpk = beforeView.getByText('过程能力 Cpk').parentElement?.textContent;
    cleanup();

    useData.getState().writeAnalysisColumns([
      { name: 'DOE拟合值', values: [900, 950, 960, 800, 1300, 1100, 600] },
      { name: 'DOE残差', values: [70, -10, 20, -110, 80, 80, -70] },
      { name: 'DOE标准化残差', values: [0.7, -0.1, 0.2, -1.1, 0.8, 0.8, -0.7] },
    ], [
      { name: 'DOE模型项', values: ['常量', '过盈量', '轴硬度', '过盈量×轴硬度', '', '', ''] },
      { name: 'DOE效应', values: ['', '-115', '85', '-325', '', '', ''] },
      { name: 'DOE系数', values: ['955', '-57.5', '42.5', '-162.5', '', '', ''] },
    ]);

    const afterView = render(createElement(Dashboard, { T: chartTokens('经典', true) }));
    expect(afterView.getByText('过程能力 Cpk').parentElement?.textContent).toBe(beforeCpk);
    cleanup();
    const spc = render(createElement(Spc, { T: chartTokens('经典', true) }));
    expect(spc.container.textContent).toContain('仅使用「压入力」的 7 个观测');
    expect(spc.getByLabelText('测量值列').textContent).not.toContain('DOE拟合值');
    expect(spc.getByLabelText('子组 ID / 点标签').textContent).not.toContain('DOE模型项');
  });

  it('12 列列式数据可从 SPC 页一键转置，原列名继续作为子组标签', () => {
    const names = Array.from({ length: 12 }, (_, i) => `批次-${101 + i}`);
    const rows = Array.from({ length: 5 }, (_, i) => names.map((_, j) => 20 + j + i / 10));
    useData.getState().importMatrix('12列.csv', names, rows);
    const view = render(createElement(Spc, { T: chartTokens('经典', true) }));

    fireEvent.click(view.getByRole('button', { name: '转为行式工作表' }));

    const st = useData.getState();
    expect(st.model.k).toBe(12);
    expect(st.model.n).toBe(5);
    expect(st.textCols).toEqual([{ name: '原列子组', values: names }]);
    expect(useApp.getState()).toMatchObject({
      spcDataLayout: 'rows', spcValueCol: null, spcSubgroupCol: 'text:原列子组',
    });
    expect(view.container.innerHTML).toContain('「原列子组」仅作子组标签，未参与测量计算');
    expect(view.container.innerHTML).toContain('批次-101');
  });

  it('单点阶段被明确拒绝，不用退化控制限把异常点洗成受控', () => {
    useData.getState().importMatrix(
      '非法阶段.csv', ['x1', 'x2'], [[10, 11], [10, 11], [100, 101], [10, 11], [10, 11]],
      [{ name: '阶段', values: ['基线', '基线', '异常点', '改善后', '改善后'] }],
    );
    useApp.setState({ spcType: 'xbar-r', spcDataLayout: 'rows', spcStageCol: '阶段' });
    const view = render(createElement(Spc, { T: chartTokens('经典', true) }));
    expect(view.container.textContent).toContain('阶段未启用');
    expect(view.container.textContent).toContain('只有 1 个点，至少需要 2 个');
    expect(view.container.textContent).toContain('分阶段未运行');
  });
});
