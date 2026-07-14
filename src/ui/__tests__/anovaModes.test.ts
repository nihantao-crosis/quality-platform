/**
 * ANOVA 批次A:残差诊断、防御 guard、宽表分组语义、摘要不再永远算演示。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { oneWayAnova, anovaResiduals } from '../../core';
import { useData } from '../../store/dataStore';
import { useApp } from '../../store/appStore';
import { useAnalyses } from '../../store/analyses';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
});

describe('anovaResiduals', () => {
  it('残差 = 观测 − 组均值,按组序展平', () => {
    const { fits, residuals } = anovaResiduals([[1, 3], [10, 14]]);
    expect(fits).toEqual([2, 2, 12, 12]);
    expect(residuals).toEqual([-1, 1, -2, 2]);
    expect(residuals.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 12);
  });
});

describe('oneWayAnova 防御', () => {
  it('组数<2 或组内 n<2 抛出明确错误', () => {
    expect(() => oneWayAnova([[1, 2, 3]])).toThrow('至少需要 2 个组');
    expect(() => oneWayAnova([[1, 2], [3]])).toThrow('每个组至少需要 2 个观测');
  });
});

describe('分析摘要与数据对齐(刘润泽场景)', () => {
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
