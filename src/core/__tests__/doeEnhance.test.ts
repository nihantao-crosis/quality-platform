/** DOE 增强批次:未编码回归方程 / 删后残差 / Lenth PSE 辅助 / 效应正态图组件守卫。
 * @vitest-environment jsdom */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectFactorial, analyzeFactorial, generateFactorialDesign, factorialCornerPredictions,
  uncodedEquation, lenthPseFromEffects, studentizedDeletedResiduals,
  type UncodedEquation,
} from '../doe';
import { EffectsNormalPlot } from '../../ui/charts/EffectsNormalPlot';
import { chartTokens } from '../../ui/tokens';
import { useData } from '../../store/dataStore';
import { useApp } from '../../store/appStore';
import { Doe } from '../../ui/pages/Doe';

/** 压装 7 行(4 角 + 3 中心)PPT 同款数据。 */
const PRESS = {
  codedA: [1, 1, 0, 0, -1, -1, 0],
  codedB: [-1, 1, 0, 0, -1, 1, 0],
  y: [1180, 1380, 980, 940, 530, 690, 970],
};

/** 在给定因子取值处求未编码方程的预测值(Ct Pt 为中心点指示 0/1)。 */
function evalEquation(eq: UncodedEquation, values: Record<string, number>, ctPt: number): number {
  return eq.terms.reduce((sum, term) => {
    if (term.label === '常量') return sum + term.coef;
    if (term.label === 'Ct Pt') return sum + term.coef * ctPt;
    const parts = term.label.split('*');
    return sum + term.coef * parts.reduce((product, name) => product * values[name], 1);
  }, 0);
}

describe('uncodedEquation:压装数据的实际单位换算自证', () => {
  // 实际物理水平:过盈量 0.045/0.0675/0.09,轴硬度 28/30/32。
  const factorValues = {
    过盈量: PRESS.codedA.map((c) => (c < 0 ? 0.045 : c > 0 ? 0.09 : 0.0675)),
    轴硬度: PRESS.codedB.map((c) => (c < 0 ? 28 : c > 0 ? 32 : 30)),
  };
  const detected = detectFactorial(
    [
      { name: '过盈量', values: factorValues.过盈量 },
      { name: '轴硬度', values: factorValues.轴硬度 },
    ],
    PRESS.y,
  );

  it('编码系数与 Minitab 已编码表一致:945.0/335.0/90.0/10.0/18.3(容差 0.1)', () => {
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    expect(Math.abs(result.grand - 945.0)).toBeLessThan(0.1);
    expect(Math.abs(result.terms.find((t) => t.name === '过盈量')!.coef - 335.0)).toBeLessThan(0.1);
    expect(Math.abs(result.terms.find((t) => t.name === '轴硬度')!.coef - 90.0)).toBeLessThan(0.1);
    expect(Math.abs(result.terms.find((t) => t.name === '过盈量×轴硬度')!.coef - 10.0)).toBeLessThan(0.1);
    expect(Math.abs(result.curvature!.coef - 18.3)).toBeLessThan(0.1);
  });

  it('物理单位系数按 x编码=(x−中心)/半量程 展开:−960 / 8222.22 / 30.0 / 222.22 / 18.33', () => {
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    const eq = uncodedEquation(result, [
      { name: '过盈量', low: 0.045, high: 0.09 },
      { name: '轴硬度', low: 28, high: 32 },
    ], '压入力');
    expect(eq).not.toBeNull();
    const coef = (label: string) => eq!.terms.find((term) => term.label === label)!.coef;
    // 手算:a12 = 10/(0.0225·2) = 222.2222;a1 = 335/0.0225 − a12·30 = 8222.2222;
    // a2 = 90/2 − a12·0.0675 = 30;c0 = 945 − 335·3 − 90·15 + a12·0.0675·30 = −960。
    expect(coef('常量')).toBeCloseTo(-960, 5);
    expect(coef('过盈量')).toBeCloseTo(8222.2222, 3);
    expect(coef('轴硬度')).toBeCloseTo(30.0, 6);
    expect(coef('过盈量*轴硬度')).toBeCloseTo(222.2222, 3);
    expect(coef('Ct Pt')).toBeCloseTo(18.3333, 3);
    expect(eq!.text.startsWith('压入力 = ')).toBe(true);
  });

  it('数学自证:未编码方程在 7 个运行的实际水平处逐点还原模型拟合值', () => {
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    const eq = uncodedEquation(result, [
      { name: '过盈量', low: 0.045, high: 0.09 },
      { name: '轴硬度', low: 28, high: 32 },
    ]);
    expect(eq).not.toBeNull();
    PRESS.y.forEach((_, row) => {
      const isCenter = PRESS.codedA[row] === 0 && PRESS.codedB[row] === 0;
      const predicted = evalEquation(eq!, {
        过盈量: factorValues.过盈量[row],
        轴硬度: factorValues.轴硬度[row],
      }, isCenter ? 1 : 0);
      expect(predicted).toBeCloseTo(result.fits[row], 6);
    });
  });

  it('系数文本为 4 位有效数字,与编码/未编码两种量纲各自匹配', () => {
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    const physical = uncodedEquation(result, [
      { name: '过盈量', low: 0.045, high: 0.09 },
      { name: '轴硬度', low: 28, high: 32 },
    ], '压入力');
    expect(physical!.text).toBe('压入力 = -960.0 + 8222 过盈量 + 30.00 轴硬度 + 222.2 过盈量*轴硬度 + 18.33 Ct Pt');
  });
});

describe('generateFactorialDesign:多区组标准序与随机化审计', () => {
  const factors = [
    { name: 'A', low: -1, high: 1 },
    { name: 'B', low: -1, high: 1 },
  ];

  it('未随机设计按区组连续，中心点位于各区组末尾，标准序=运行序', () => {
    const design = generateFactorialDesign(factors, { blocks: 2, centerPoints: 1, randomize: false });
    expect(design.rows.map((row) => row.slice(0, 3))).toEqual([
      [1, 1, 1], [2, 2, 1], [3, 3, 1],
      [4, 4, 2], [5, 5, 2], [6, 6, 2],
    ]);
    expect(design.textCols[0].values).toEqual([
      '因子点', '因子点', '中心点', '因子点', '因子点', '中心点',
    ]);
  });

  it('固定种子只在区组内改运行序；每个因子组合的标准序与未随机设计一致', () => {
    const base = generateFactorialDesign(factors, { blocks: 2, centerPoints: 1, randomize: false });
    const randomized = generateFactorialDesign(factors, { blocks: 2, centerPoints: 1, randomize: true, seed: 42 });
    expect(randomized.rows.map((row) => row[2])).toEqual([1, 1, 1, 2, 2, 2]);
    const key = (row: number[], pointType: string) => `${row.slice(2, 5).join('|')}|${pointType}`;
    const baseStd = new Map(base.rows.map((row, index) => [key(row, base.textCols[0].values[index]), row[0]]));
    randomized.rows.forEach((row, index) => {
      expect(row[0]).toBe(baseStd.get(key(row, randomized.textCols[0].values[index])));
      expect(row[1]).toBe(index + 1);
    });
  });
});

describe('uncodedEquation:适用范围守卫', () => {
  it('模型含三因子交互时返回 null;去掉高阶交互后可展开', () => {
    const detected = detectFactorial(
      [
        { name: 'A', values: [0, 1, 0, 1, 0, 1, 0, 1] },
        { name: 'B', values: [0, 0, 1, 1, 0, 0, 1, 1] },
        { name: 'C', values: [0, 0, 0, 0, 1, 1, 1, 1] },
      ],
      [42, 55, 45, 58, 48, 62, 52, 66],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const factors = [
      { name: 'A', low: 0, high: 1 }, { name: 'B', low: 0, high: 1 }, { name: 'C', low: 0, high: 1 },
    ];
    const full = analyzeFactorial(detected.design); // 含 A×B×C
    expect(full.terms.some((term) => term.name === 'A×B×C')).toBe(true);
    expect(uncodedEquation(full, factors)).toBeNull();
    const upTo2fi = analyzeFactorial(detected.design, { terms: ['A', 'B', 'C', 'A×B', 'A×C', 'B×C'] });
    expect(uncodedEquation(upTo2fi, factors)).not.toBeNull();
  });

  it('项名与因子定义对不上、或水平非法时返回 null', () => {
    const detected = detectFactorial(
      [{ name: 'A', values: [0, 1, 0, 1] }, { name: 'B', values: [0, 0, 1, 1] }],
      [10, 20, 14, 30],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    expect(uncodedEquation(result, [
      { name: '别的名字', low: 0, high: 1 }, { name: 'B', low: 0, high: 1 },
    ])).toBeNull();
    expect(uncodedEquation(result, [
      { name: 'A', low: 1, high: 0 }, { name: 'B', low: 0, high: 1 },
    ])).toBeNull();
    expect(uncodedEquation(result, [])).toBeNull();
  });

  it('有区组时常数按区组等权平均并入,与角点 LS 预测同口径', () => {
    const generated = generateFactorialDesign(
      [{ name: 'A', low: -1, high: 1 }, { name: 'B', low: -1, high: 1 }],
      { blocks: 2 },
    );
    const blocks = generated.rows.map((row) => row[2]);
    const response = blocks.map((block) => (block === 1 ? 100 : 0));
    const detected = detectFactorial(
      [
        { name: 'A', values: generated.rows.map((row) => row[3]) },
        { name: 'B', values: generated.rows.map((row) => row[4]) },
      ],
      response,
      { blocks },
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    const eq = uncodedEquation(result, [
      { name: 'A', low: -1, high: 1 }, { name: 'B', low: -1, high: 1 },
    ]);
    expect(eq).not.toBeNull();
    expect(eq!.terms[0].coef).toBeCloseTo(50, 8); // 100(参照区组) + (−100)/2
    for (const corner of factorialCornerPredictions(result, detected.design)) {
      const predicted = evalEquation(eq!, { A: corner.coded[0], B: corner.coded[1] }, 0);
      expect(predicted).toBeCloseTo(corner.predicted, 8);
    }
  });
});

describe('lenthPseFromEffects:与饱和设计的 PSE 一致且尺度等变', () => {
  it('2² 饱和设计:效应 [13,7,3] → PSE = 10.5,与 analyzeFactorial 输出一致', () => {
    const detected = detectFactorial(
      [{ name: 'A', values: [0, 1, 0, 1] }, { name: 'B', values: [0, 0, 1, 1] }],
      [10, 20, 14, 30],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    expect(result.method).toBe('lenth');
    expect(result.pse).toBeCloseTo(10.5, 8);
    expect(lenthPseFromEffects(result.terms.map((term) => term.effect))).toBeCloseTo(result.pse!, 8);
    expect(lenthPseFromEffects([13, -7, 3])).toBeCloseTo(10.5, 10);
    expect(lenthPseFromEffects([1300, -700, 300])).toBeCloseTo(1050, 8);
    expect(lenthPseFromEffects([])).toBe(0);
  });
});

describe('studentizedDeletedResiduals:5 点手算锚点', () => {
  it('t_i = r_i·√((ν−1)/(ν−r_i²)) 与「删除第 i 点后重估 MSE」的定义一致', () => {
    const detected = detectFactorial(
      [{ name: 'A', values: [0, 1, 0, 1, 1] }, { name: 'B', values: [0, 0, 1, 1, 1] }],
      [10, 20, 14, 30, 32],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    // 只入主效应:N=5、秩=3(常数+A+B)、ν=2。手算 OLS:XᵀX=[[5,1,1],[1,5,1],[1,1,5]],
    // b=(19,7,4);拟合 [8,22,16,30,30],残差 [2,−2,−2,0,2],SSE=16,MSE=8;
    // 杠杆 h=[5/7,5/7,5/7,3/7,3/7] → 标准化残差 [√7/2,−√7/2,−√7/2,0,√(7/8)];
    // 删后残差 [√7,−√7,−√7,0,√7/3]。交叉验证:删除点 1 后 MSE₍₁₎=(16−4/(2/7))/1=2,
    // t₁ = 2/√(2·(2/7)) = √7;删除点 5 后 MSE₍₅₎=9,t₅ = 2/√(9·(4/7)) = √7/3。
    const result = analyzeFactorial(detected.design, { terms: ['A', 'B'] });
    expect(result.method).toBe('ttest');
    expect(result.dfResid).toBe(2);
    expect(result.mse).toBeCloseTo(8, 8);
    [8, 22, 16, 30, 30].forEach((fit, row) => expect(result.fits[row]).toBeCloseTo(fit, 8));
    [2, -2, -2, 0, 2].forEach((residual, row) => expect(result.residuals[row]).toBeCloseTo(residual, 8));
    const s7 = Math.sqrt(7);
    [s7 / 2, -s7 / 2, -s7 / 2, 0, Math.sqrt(7 / 8)].forEach((std, row) =>
      expect(result.stdResiduals![row]).toBeCloseTo(std, 6));
    const deleted = studentizedDeletedResiduals(result);
    expect(deleted).not.toBeNull();
    [s7, -s7, -s7, 0, s7 / 3].forEach((t, row) => expect(deleted![row]).toBeCloseTo(t, 6));
  });
});

describe('残差三类型的守卫:完美拟合与自由度耗尽', () => {
  it('完美拟合(残差全 0,ν=4):正规/标准化/删后全为 0,不产生 NaN', () => {
    const detected = detectFactorial(
      [
        { name: 'A', values: [0, 1, 0, 1, 0, 1, 0, 1] },
        { name: 'B', values: [0, 0, 1, 1, 0, 0, 1, 1] },
      ],
      [10, 20, 10, 20, 10, 20, 10, 20],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    expect(result.dfResid).toBe(4);
    expect(result.residuals.every((value) => Math.abs(value) < 1e-9)).toBe(true);
    expect(result.stdResiduals!.every((value) => value === 0)).toBe(true);
    const deleted = studentizedDeletedResiduals(result);
    expect(deleted).not.toBeNull();
    expect(deleted!.every((value) => value === 0)).toBe(true);
  });

  it('ν=0(饱和设计):无标准化残差,删后残差返回 null(选项应禁用)', () => {
    const detected = detectFactorial(
      [{ name: 'A', values: [0, 1, 0, 1] }, { name: 'B', values: [0, 0, 1, 1] }],
      [10, 20, 14, 30],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    expect(result.dfResid).toBe(0);
    expect(result.stdResiduals).toBeUndefined();
    expect(studentizedDeletedResiduals(result)).toBeNull();
  });

  it('ν=1:删后公式 √((ν−1)/(ν−r²)) 自由度耗尽,返回 null(选项应禁用)', () => {
    const detected = detectFactorial(
      [{ name: 'A', values: [0, 1, 0, 1, 1] }, { name: 'B', values: [0, 0, 1, 1, 1] }],
      [10, 20, 14, 30, 32],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design); // 全模型:ν=1
    expect(result.dfResid).toBe(1);
    expect(studentizedDeletedResiduals(result)).toBeNull();
  });

  it('边界 r²=ν(删除后完美拟合)给 ±Infinity,零残差仍为 0', () => {
    const deleted = studentizedDeletedResiduals({ dfResid: 2, stdResiduals: [Math.sqrt(2), -0.5, 0] });
    expect(deleted).not.toBeNull();
    expect(deleted![0]).toBe(Infinity);
    expect(deleted![1]).toBeCloseTo(-0.5 * Math.sqrt(1 / 1.75), 6);
    expect(deleted![2]).toBe(0);
  });
});

describe('EffectsNormalPlot 组件守卫(正态/半正态)', () => {
  const T = chartTokens('经典', true);
  const terms = [
    { name: '过盈量', effect: 670, sig: true },
    { name: '轴硬度', effect: 180, sig: true },
    { name: '过盈量×轴硬度', effect: 20, sig: false },
  ];

  it('普通与半正态模式坐标有限,显著项以红色标签标注', () => {
    for (const half of [false, true]) {
      const svg = renderToStaticMarkup(createElement(EffectsNormalPlot, { T, terms, pse: 30, half }));
      expect(svg).not.toContain('NaN');
      expect(svg).toContain('过盈量'); // 显著项标签
      expect(svg).toContain(T.limit);  // 红点/标签用 limit 色
      expect(svg).toContain(half ? '半正态分位' : '正态分位');
      expect(svg).toContain('PSE=30.000');
    }
  });

  it('效应全 0 且 PSE=0 时仍为有限坐标,并提示参考线不可用', () => {
    const svg = renderToStaticMarkup(createElement(EffectsNormalPlot, {
      T, terms: [{ name: 'A', effect: 0, sig: false }, { name: 'B', effect: 0, sig: false }], pse: 0,
    }));
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('PSE=0,参考线不可用');
  });

  it('无可估计效应时给出空态文案', () => {
    const svg = renderToStaticMarkup(createElement(EffectsNormalPlot, { T, terms: [], pse: 1 }));
    expect(svg).toContain('无可估计效应');
  });
});

describe('Doe 页真实数据渲染冒烟:本批次新增卡与控件', () => {
  const T = chartTokens('经典', true);
  // renderToStaticMarkup 走 zustand 的 getInitialState(服务器快照),看不到 setState;
  // 页面冒烟必须用客户端渲染(与 spcWorkflow 等 UI 测试同一模式)。
  const renderDoe = () => {
    const html = render(createElement(Doe, { T })).container.innerHTML;
    cleanup();
    return html;
  };
  afterEach(cleanup);

  it('分析页含效应图三页签/未编码方程卡/残差类型与布局/残差 vs 变量,四视图无 NaN', () => {
    localStorage.clear();
    useData.getState().importMatrix('压装DOE', ['过盈量', '轴硬度', '压入力'], [
      [0.09, 28, 1180], [0.09, 32, 1380], [0.0675, 30, 980], [0.0675, 30, 940],
      [0.045, 28, 530], [0.045, 32, 690], [0.0675, 30, 970],
    ]);
    useApp.setState({
      doeTab: 'analyze', doeView: 'pareto',
      doeFactorCols: ['过盈量', '轴硬度'], doeRespCol: '压入力',
      doeModelTerms: null, doeIncludeCurvature: true,
    });
    const html = renderDoe();
    expect(html).not.toContain('NaN');
    for (const probe of [
      '帕累托', '正态', '半正态',
      '回归方程(未编码单位)',
      '压入力 = -960.0 + 8222 过盈量 + 30.00 轴硬度 + 222.2 过盈量*轴硬度 + 18.33 Ct Pt',
      '残差诊断(四合一)', '残差类型', '正规', '标准化', '删后', '四合一', '单独',
      '残差 vs 变量', 'ν(残差自由度)= 2',
    ]) {
      expect(html, `分析页应包含「${probe}」`).toContain(probe);
    }
    for (const view of ['main', 'interact', 'cube'] as const) {
      useApp.setState({ doeView: view });
      expect(renderDoe()).not.toContain('NaN');
    }
  });

  it('交互:切半正态图/删后残差/单独布局/vs 顺序后,新增内容真实渲染且无 NaN', () => {
    localStorage.clear();
    useData.getState().importMatrix('压装DOE', ['过盈量', '轴硬度', '压入力'], [
      [0.09, 28, 1180], [0.09, 32, 1380], [0.0675, 30, 980], [0.0675, 30, 940],
      [0.045, 28, 530], [0.045, 32, 690], [0.0675, 30, 970],
    ]);
    useApp.setState({
      doeTab: 'analyze', doeView: 'pareto',
      doeFactorCols: ['过盈量', '轴硬度'], doeRespCol: '压入力',
      doeModelTerms: null, doeIncludeCurvature: true,
    });
    const view = render(createElement(Doe, { T }));
    fireEvent.click(view.getByText('半正态'));
    expect(view.container.innerHTML).toContain('半正态分位');
    expect(view.container.innerHTML).toContain('参考线过原点,斜率 PSE=');
    fireEvent.click(view.getByText('删后'));
    fireEvent.click(view.getByText('单独'));
    expect(view.container.innerHTML).toContain('残差诊断(单独放大)');
    expect(view.container.innerHTML).toContain('删后残差 t = r·√((ν−1)/(ν−r²))');
    fireEvent.click(view.getByText('vs 顺序'));
    // 批次720-C3:轴题对齐 Minitab「与顺序」面板 → 观测值顺序
    expect(view.container.innerHTML).toContain('观测值顺序');
    expect(view.container.innerHTML).not.toContain('NaN');
  });

  it('创建页:因子数为数字输入、随机化种子可见且默认沿用固定种子、仿行数标签明确角点重复', () => {
    useApp.setState({ doeTab: 'create' });
    const html = renderDoe();
    // 批次720-C4:默认自动换种子(工厂反馈「运行序非随机」=固定默认种子每次生成相同);
    // 输入框初始仍显示固定种子,tooltip 说明改为自动换种+同种子可复现
    for (const probe of ['因子数', '随机化种子', '仿行数(角点重复)', '20260713', '同种子完全复现', '自动换新种子']) {
      expect(html, `创建页应包含「${probe}」`).toContain(probe);
    }
    expect(html).not.toContain('本版支持 2–4 因子'); // 默认 k=2 合法,不出现越界提示
  });
});
