/**
 * ANOVA 批次A:残差诊断、防御 guard、宽表分组语义、摘要不再永远算演示。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, render } from '@testing-library/react';
import {
  oneWayAnova, anovaResiduals, anovaGroupSummaries, buildAnovaGroups, buildAnovaStructuredReport,
  resolveAnovaMode, resolveAnovaNumericRoles,
} from '../../core';
import { useData } from '../../store/dataStore';
import { useApp } from '../../store/appStore';
import { useAnalyses } from '../../store/analyses';
import { NormalProbPlot } from '../charts/NormalProbPlot';
import { BoxPlot, IndividualValuePlot, IntervalPlot } from '../charts/misc';
import { chartTokens } from '../tokens';
import { Anova } from '../pages/SimplePages';

// 独立复现 GPT 复审给出的 P≈0.0168076：两组各 500 点，只有 1e9±5e-6 两个值。
// A 的稳定均值高于 B；刻意安排相反的行序后，旧展示层朴素 reduce 会错误判成 B 更高。
const ANOVA_AUDIT_BASE = 1e9;
const ANOVA_AUDIT_LOW = ANOVA_AUDIT_BASE - 5e-6;
const ANOVA_AUDIT_HIGH = ANOVA_AUDIT_BASE + 5e-6;
const ANOVA_AUDIT_A = [...Array(50).fill(ANOVA_AUDIT_LOW), ...Array(450).fill(ANOVA_AUDIT_HIGH)] as number[];
const ANOVA_AUDIT_B = [...Array(425).fill(ANOVA_AUDIT_HIGH), ...Array(75).fill(ANOVA_AUDIT_LOW)] as number[];

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [], lastError: null });
  useApp.setState({
    page: 'dashboard', hypoTab: 'anova', anovaMode: 'stacked', anovaRespName: null, anovaFactorName: null,
    anovaShowDemo: false, t1ColName: null, t1Mu0: null, t2ColAName: null, t2ColBName: null,
    regXName: null, regYName: null,
  });
});

describe('ANOVA 常数数据图形边界', () => {
  it('组内与组间都为常数时箱线图不产生 NaN 坐标', () => {
    const svg = renderToStaticMarkup(createElement(BoxPlot, {
      T: chartTokens('经典', true),
      groups: [{ name: 'A', vals: [1, 1] }, { name: 'B', vals: [1, 1] }],
    }));
    expect(svg).not.toContain('NaN');
  });
});

describe('ANOVA 大基准微扰展示链稳定性', () => {
  it('核心组均值判 A 最高且 P≈0.0168076，正反序结果一致', () => {
    const result = oneWayAnova([ANOVA_AUDIT_A, ANOVA_AUDIT_B]);
    const reversed = oneWayAnova([[...ANOVA_AUDIT_A].reverse(), [...ANOVA_AUDIT_B].reverse()]);
    const summaries = anovaGroupSummaries([
      { name: '稳定A', vals: ANOVA_AUDIT_A },
      { name: '稳定B', vals: ANOVA_AUDIT_B },
    ], result);
    // 证明该夹具确实会触发旧展示缺陷，而非只验证一个普通显著样本。
    const legacyMeans = [ANOVA_AUDIT_A, ANOVA_AUDIT_B]
      .map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
    expect(legacyMeans[0]).toBeLessThan(legacyMeans[1]);
    expect(summaries[0].mean).toBeGreaterThan(summaries[1].mean);
    expect(result.pValue).toBeCloseTo(0.016807634457, 10);
    expect(reversed.pValue).toBeCloseTo(result.pValue, 12);
    expect(result.significant).toBe(true);
  });

  it('页面最高组直接跟随核心稳定摘要，组内正反序都判稳定A', () => {
    const pageConclusion = (a: number[], b: number[]) => {
      useData.getState().importMatrix(
        'ANOVA微扰.csv',
        ['稳定A', '稳定B'],
        a.map((value, index) => [value, b[index]]),
      );
      useApp.setState({
        page: 'anova', hypoTab: 'anova', anovaMode: 'wide',
        anovaRespName: null, anovaFactorName: null, anovaShowDemo: false,
      });
      const text = render(createElement(Anova, { T: chartTokens('经典', true) })).container.textContent ?? '';
      cleanup();
      return text;
    };
    expect(pageConclusion(ANOVA_AUDIT_A, ANOVA_AUDIT_B)).toContain('「稳定A」组均值最高');
    expect(pageConclusion([...ANOVA_AUDIT_A].reverse(), [...ANOVA_AUDIT_B].reverse()))
      .toContain('「稳定A」组均值最高');
  });

  it('箱线图均值标记使用稳定 mean，同一组正反序 SVG 完全一致', () => {
    const T = chartTokens('经典', true);
    const draw = (a: number[], b: number[]) => renderToStaticMarkup(createElement(BoxPlot, {
      T,
      groups: [{ name: '稳定A', vals: a }, { name: '稳定B', vals: b }],
    }));
    expect(draw(ANOVA_AUDIT_A, ANOVA_AUDIT_B))
      .toBe(draw([...ANOVA_AUDIT_A].reverse(), [...ANOVA_AUDIT_B].reverse()));
  });
});

describe('anovaResiduals', () => {
  it('残差 = 观测 − 组均值,按组序展平', () => {
    const { fits, residuals } = anovaResiduals([[1, 3], [10, 14]]);
    expect(fits).toEqual([2, 2, 12, 12]);
    expect(residuals).toEqual([-1, 1, -2, 2]);
    expect(residuals.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 12);
  });

  it('传入工作表行号时,残差恢复原始观测顺序', () => {
    const groups = buildAnovaGroups(
      'numfactor',
      ['水平', '响应'],
      [[2, 20], [1, 10], [2, 24], [1, 16]],
      [],
      '响应',
      '水平',
    );
    expect(groups).not.toBeNull();
    const { fits, residuals } = anovaResiduals(
      groups!.map((g) => g.vals),
      groups!.map((g) => g.rowIndices!),
    );
    expect(fits).toEqual([22, 13, 22, 13]);
    expect(residuals).toEqual([-2, -3, 2, 3]);
  });
});

describe('方差分析图形边界', () => {
  const T = chartTokens('经典', true);

  it('全零残差的正态概率图不输出 NaN', () => {
    const svg = renderToStaticMarkup(createElement(NormalProbPlot, { T, data: [0, 0, 0, 0], h: 220 }));
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('数据无变异');
  });

  it('区间图可使用 ANOVA 合并误差,个体值图绘制原始观测', () => {
    const groups = [{ name: 'A', vals: [1, 3] }, { name: 'B', vals: [10, 14] }];
    const interval = renderToStaticMarkup(createElement(IntervalPlot, { T, groups, pooledError: { mse: 5, df: 2 } }));
    const individual = renderToStaticMarkup(createElement(IndividualValuePlot, { T, groups }));
    expect(interval).toContain('合并误差 MSE');
    expect(interval).not.toContain('NaN');
    expect(individual.match(/<circle/g)).toHaveLength(4);
    expect(individual).toContain('短横线 = 组均值');
  });

  it('大样本个体值图明确标注抽稀比例并强制保留极值', () => {
    const a = Array.from({ length: 1500 }, (_, i) => i / 10);
    a[777] = 9999;
    const svg = renderToStaticMarkup(createElement(IndividualValuePlot, {
      T,
      groups: [{ name: 'A', vals: a }, { name: 'B', vals: [1, 2] }],
    }));
    expect(svg).toContain('渲染');
    expect(svg).toContain('含极值');
    expect(svg).toContain('A · 9999.0000');
  });
});

describe('oneWayAnova 防御', () => {
  it('组数<2 或组内 n<2 抛出明确错误', () => {
    expect(() => oneWayAnova([[1, 2, 3]])).toThrow('至少需要 2 个组');
    expect(() => oneWayAnova([[1, 2], [3]])).toThrow('每个组至少需要 2 个观测');
    expect(() => oneWayAnova([[1, 2], [3, Number.NaN]])).toThrow('有限数值');
  });
});

describe('人工反馈 ANOVA 精确 7 行', () => {
  // 原始 PPT 工作表（按运行序）：标准序 1/4/6/7/3/2/5。
  const rows = [
    [0.045, 28, 970],
    [0.09, 32, 940],
    [0.0675, 30, 980],
    [0.0675, 30, 690],
    [0.045, 32, 1380],
    [0.09, 28, 1180],
    [0.0675, 30, 530],
  ];

  it('压入力 vs 过盈量给出完整 DF/SS/MS/F/P 与 PPT 分组统计', () => {
    const groups = buildAnovaGroups('numfactor', ['过盈量', '轴硬度', '压入力'], rows, [], '压入力', '过盈量');
    expect(groups).not.toBeNull();
    const result = oneWayAnova(groups!.map((group) => group.vals));
    expect(result).toMatchObject({ factorDf: 2, errorDf: 4, totalDf: 6 });
    expect(result.factorSS).toBeCloseTo(266226.190476, 5);
    expect(result.errorSS).toBeCloseTo(216916.666667, 5);
    expect(result.factorMS).toBeCloseTo(133113.095238, 5);
    expect(result.errorMS).toBeCloseTo(54229.166667, 5);
    expect(result.fStat).toBeCloseTo(2.45464025, 7);
    expect(result.pValue).toBeGreaterThan(0.05);
    const summaries = anovaGroupSummaries(groups!, result);
    expect(summaries.map(({ n, mean, stDev }) => ({ n, mean, stDev }))).toEqual([
      { n: 2, mean: 1175, stDev: expect.closeTo(289.9137803, 6) },
      { n: 3, mean: expect.closeTo(733.3333333, 6), stDev: expect.closeTo(228.1081615, 6) },
      { n: 2, mean: 1060, stDev: expect.closeTo(169.7056275, 6) },
    ]);
    expect(summaries.every((summary) => summary.ciLow < summary.mean && summary.ciHigh > summary.mean)).toBe(true);
  });

  it('带 DOE 元数据时自动排除标准序/运行序/区组，直接识别数值因子模式', () => {
    const names = ['标准序', '运行序', '区组', '过盈量', '轴硬度', '压入力'];
    const withMetadata = rows.map((row, index) => [index + 1, index + 1, 1, ...row]);
    const roles = resolveAnovaNumericRoles(names, withMetadata, null, null);
    expect(roles).toMatchObject({ eligibleIdx: [3, 4, 5], factorIdx: 3, respIdx: 5, hasValidFactor: true });
    expect(resolveAnovaMode('stacked', names, withMetadata, 0, null, null)).toBe('numfactor');
    const groups = buildAnovaGroups('numfactor', names, withMetadata, [], null, null);
    expect(groups?.map((group) => group.name)).toEqual(['过盈量=0.045', '过盈量=0.0675', '过盈量=0.09']);
    const explicitInvalid = resolveAnovaNumericRoles(names, withMetadata, '轴硬度', '压入力');
    expect(explicitInvalid).toMatchObject({ factorIdx: 5, respIdx: 4, hasValidFactor: false });
    expect(buildAnovaGroups('numfactor', names, withMetadata, [], '轴硬度', '压入力')).toBeNull();
  });

  it('结构化专项报告保留工作表行序残差与合并 MSE', () => {
    const groups = buildAnovaGroups('numfactor', ['过盈量', '轴硬度', '压入力'], rows, [], '压入力', '过盈量')!;
    const report = buildAnovaStructuredReport({ responseName: '压入力', factorName: '过盈量', groups });
    expect(report).toMatchObject({ kind: 'one-way-anova', responseName: '压入力', factorName: '过盈量', confidence: 0.95 });
    expect(report.sources.map((source) => source.source)).toEqual(['过盈量', '误差', '合计']);
    expect(report.sources[1].ms).toBeCloseTo(54229.166667, 5);
    expect(report.diagnostics.worksheetOrder).toBe(true);
    expect(report.diagnostics.residuals).toHaveLength(7);
    expect(report.diagnostics.residuals[0]).toBeCloseTo(-205, 10);
    expect(report.diagnostics.residuals[1]).toBeCloseTo(-120, 10);
  });
});

describe('分析摘要与数据对齐(刘润泽场景)', () => {
  it('真实数据一旦可分析，即使残留“查看示例”标志也不再保存演示结果', () => {
    useData.getState().importMatrix('真实ANOVA', ['因子', '响应'], [[1, 10], [1, 11], [2, 20], [2, 21]]);
    useApp.setState({
      page: 'anova', hypoTab: 'anova', anovaMode: 'numfactor', anovaFactorName: '因子', anovaRespName: '响应',
      anovaShowDemo: true,
    });
    const text = render(createElement(Anova, { T: chartTokens('经典', true) })).container.textContent ?? '';
    expect(text).toContain('方差分析表');
    expect(text).not.toContain('示例研究(设备 A/B/C × 直径)');
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved?.title).toBe('单因子 ANOVA');
    expect(saved?.status).not.toBe('演示');
  });

  it('t1/t2/回归页面与保存端共同拦截参与列的待录入占位值', () => {
    const cases = [
      { tab: 't1' as const, patch: { t1ColName: 'A' }, pending: [{ row: 0, col: 0 }] },
      { tab: 't2' as const, patch: { t2ColAName: 'A', t2ColBName: 'B' }, pending: [{ row: 1, col: 1 }] },
      { tab: 'reg' as const, patch: { regXName: 'A', regYName: 'C' }, pending: [{ row: 2, col: 2 }] },
    ];
    for (const current of cases) {
      cleanup();
      useData.getState().importMatrix('待录入检验', ['A', 'B', 'C'], [[0, 2, 3], [2, 0, 4], [3, 4, 0]], [], current.pending);
      useApp.setState({ page: 'anova', hypoTab: current.tab, ...current.patch });
      const text = render(createElement(Anova, { T: chartTokens('经典', true) })).container.textContent ?? '';
      expect(text).toContain('分析尚未运行');
      expect(text).toContain('1 个待录入');
      expect(text).not.toContain('检验结果');
      expect(text).not.toContain('回归统计');
      const saved = useAnalyses.getState().saveCurrent();
      expect(saved).toMatchObject({ status: '未分析', metric: '尚有 1 格未录入' });
    }
  });

  it('ANOVA 待录入占位值在页面和保存摘要均明确拦截', () => {
    useData.getState().importMatrix(
      'ANOVA待录入', ['因子', '响应'], [[1, 0], [1, 10], [2, 20], [2, 22]], [], [{ row: 0, col: 1 }],
    );
    useApp.setState({ page: 'anova', hypoTab: 'anova', anovaMode: 'numfactor', anovaFactorName: '因子', anovaRespName: '响应' });
    const html = render(createElement(Anova, { T: chartTokens('经典', true) })).container.textContent ?? '';
    expect(html).toContain('ANOVA 尚未运行');
    expect(html).toContain('1 个待录入');
    expect(html).not.toContain('方差分析表');
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved).toMatchObject({ status: '未分析', metric: '尚有 1 格未录入' });
  });

  it('生成设计的元数据与点类型不抢占 ANOVA 变量角色，默认即得到真实 P 值', () => {
    const source = [
      [0.045, 28, 970], [0.09, 32, 940], [0.0675, 30, 980], [0.0675, 30, 690],
      [0.045, 32, 1380], [0.09, 28, 1180], [0.0675, 30, 530],
    ];
    useData.getState().importMatrix(
      'ANOVA反馈7行', ['标准序', '运行序', '区组', '过盈量', '轴硬度', '压入力'],
      source.map((row, index) => [index + 1, index + 1, 1, ...row]),
      [{ name: '点类型', values: ['因子点', '因子点', '中心点', '中心点', '因子点', '因子点', '中心点'] }],
    );
    useApp.setState({
      page: 'anova', hypoTab: 'anova', anovaMode: 'stacked', anovaFactorName: null, anovaRespName: null,
    });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved?.metric).toMatch(/^P /);
    expect(saved?.status).toBe('不显著');
  });

  it('导入 3 列异量纲数值后,ANOVA 摘要标"存疑"而非固化无意义的显著 P', () => {
    useData.getState().importMatrix('压装.csv', ['过盈量', '轴硬度', '压入力'], [
      [0.045, 28, 620], [0.0675, 30, 900], [0.09, 32, 1350], [0.045, 32, 700], [0.09, 28, 1200],
    ]);
    useApp.setState({ page: 'anova', hypoTab: 'anova', anovaMode: 'wide', anovaRespName: null, anovaFactorName: null });
    const saved = useAnalyses.getState().saveCurrent();
    // 摘要来自用户数据集(不回落演示);且因量纲悬殊(0.07 vs 30 vs ~900)不把"极显著"固化,给存疑。
    expect(saved?.datasetName).toBe('压装.csv');
    expect(saved?.status).toBe('存疑');
    expect(saved?.metric).toContain('量纲悬殊');
  });

  it('DOE 部分录入(响应待录入列仍有占位 0)→ 摘要判"未录入"而非出显著结论', () => {
    // 生成设计:2 因子 + 中心点,响应列名含"待录入",只录第一行、其余为 0
    const rows = [
      [0.045, 28, 620], [0.09, 28, 0], [0.045, 32, 0], [0.09, 32, 0],
      [0.0675, 30, 0], [0.0675, 30, 0], [0.0675, 30, 0],
    ];
    useData.getState().importMatrix(
      'DOE部分录入',
      ['过盈量', '轴硬度', '响应(待录入)'],
      rows,
      [],
      rows.slice(1).map((_, i) => ({ row: i + 1, col: 2 })),
    );
    useApp.setState({ page: 'doe', doeFactorCols: ['过盈量', '轴硬度'], doeRespCol: '响应(待录入)' });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved?.status).toBe('未分析');
    expect(saved?.metric).toContain('未录入');
  });

  it('数值因子模式:压入力 按 轴硬度 水平分组,给出真实单因子 ANOVA', () => {
    // 轴硬度 只有 28/32 两水平,每组 ≥2 → 可构成有效分组
    useData.getState().importMatrix('压装2.csv', ['轴硬度', '压入力'], [
      [28, 620], [28, 700], [32, 1350], [32, 1200], [28, 640], [32, 1300],
    ]);
    useApp.setState({ page: 'anova', hypoTab: 'anova', anovaMode: 'numfactor', anovaFactorName: '轴硬度', anovaRespName: '压入力' });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved?.datasetName).toBe('压装2.csv');
    expect(saved?.metric).toMatch(/^P /); // 同量纲响应按因子水平分组 → 正当的 P
  });
});
