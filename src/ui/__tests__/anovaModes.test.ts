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
  it('导入 3 列纯数值后,ANOVA 摘要按宽表(各列一组)实算,而非演示组', () => {
    useData.getState().importMatrix('压装.csv', ['过盈量', '轴硬度', '压入力'], [
      [0.045, 28, 620], [0.0675, 30, 900], [0.09, 32, 1350], [0.045, 32, 700], [0.09, 28, 1200],
    ]);
    useApp.setState({ page: 'anova', hypoTab: 'anova' });
    const saved = useAnalyses.getState().saveCurrent();
    // 三列量纲悬殊 → 宽表 F 检验必然显著;演示组 P≈0.012 也显著,但数据集名必须是用户的
    expect(saved?.datasetName).toBe('压装.csv');
    expect(saved?.metric).toMatch(/^P /);
    // 宽表实算的 P 值应远小于演示的 0.012(组间差异巨大)
    const p = parseFloat(saved!.metric.replace('P ', ''));
    expect(p).toBeLessThan(0.001);
  });
});
