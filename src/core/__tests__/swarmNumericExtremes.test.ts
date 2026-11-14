import { describe, expect, it } from 'vitest';
import { computeGagePanelData, computeGageRR, type GageObservation } from '../gage';
import { computeVarModel, withSigmaMethod, type VarModel } from '../model';
import { CONTROL_CONSTANTS } from '../spc';

const MAXIMUM = Number.MAX_VALUE;
const EXTREME_ROWS = [
  [-MAXIMUM, MAXIMUM],
  ...Array.from({ length: 7 }, () => [0, 0]),
];

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual / expected - 1);
}

function expectFiniteSpcDerivations(model: VarModel): void {
  const values = [
    model.xbarbar, model.rbar, model.rCl,
    model.uclX, model.lclX, model.uclR, model.lclR,
    model.sbar, model.sCl, model.uclXs, model.lclXs, model.uclS, model.lclS,
    model.sigmaChart, model.sigmaChartS, model.sigmaPooled, model.sigmaWithin,
    model.oMean, model.oSd,
    model.mrbar, model.indMean, model.iUcl, model.iLcl, model.mrUcl, model.iSig,
    ...model.subs.flatMap((subgroup) => [subgroup.mean, subgroup.range]),
    ...model.svals,
    ...model.mr.filter((value): value is number => value != null),
  ];
  expect(values.every(Number.isFinite)).toBe(true);
}

function extremeGageStudy(): GageObservation[] {
  return EXTREME_ROWS.flatMap((trials, part) => trials.map((value, trial) => ({
    part,
    operator: 0,
    trial,
    value,
  })));
}

describe('有限极值坐标的 SPC/Gage 统计', () => {
  it('子组极差先在共同坐标域聚合，不会把饱和后的单组 range 拿去求 R̄', () => {
    const model = computeVarModel('±MAX.csv', ['x1', 'x2'], EXTREME_ROWS);
    const expectedRbar = MAXIMUM / 4;
    const expectedSigma = expectedRbar / CONTROL_CONSTANTS[2].d2;

    // 第一组真实 range=2·MAX，单项对外饱和；八组聚合值仍可表示且必须正确。
    expect(model.subs[0].range).toBe(MAXIMUM);
    expect(model.rbar).toBe(expectedRbar);
    expect(relativeError(model.sigmaWithin, expectedSigma)).toBeLessThan(2e-15);
    expect(relativeError(model.sigmaChart, expectedSigma)).toBeLessThan(2e-15);
    // 展平序列的 MR 真值和为 3·MAX，15 个 MR 的平均仍可表示。
    expect(relativeError(model.mrbar, MAXIMUM / 5)).toBeLessThan(2e-15);
    expectFiniteSpcDerivations(model);

    const pooled = withSigmaMethod(model, 'pooled');
    const classicAgain = withSigmaMethod(pooled, 'classic');
    expectFiniteSpcDerivations(pooled);
    expectFiniteSpcDerivations(classicAgain);
    expect(relativeError(classicAgain.rbar, expectedRbar)).toBeLessThan(2e-15);
    expect(relativeError(classicAgain.sigmaChart, expectedSigma)).toBeLessThan(2e-15);
  });

  it('Gage 胞极差/R̄/限值与 ANOVA 结果在 8部件×1人×2重复的 ±MAX 研究中全部有限', () => {
    const observations = extremeGageStudy();
    const panel = computeGagePanelData(observations, CONTROL_CONSTANTS[2]);
    const result = computeGageRR(observations, null);
    const expectedRbar = MAXIMUM / 4;

    expect(panel.cellRanges[0][0]).toBe(MAXIMUM);
    expect(panel.rBar).toBe(expectedRbar);
    expect(panel.grandMean).toBe(0);
    expect([
      ...panel.cellMeans.flat(),
      ...panel.cellRanges.flat(),
      ...panel.partMeans,
      ...panel.operatorMeans,
      panel.grandMean,
      panel.rBar,
      ...(panel.rLimits ? Object.values(panel.rLimits) : []),
      ...(panel.xbarLimits ? Object.values(panel.xbarLimits) : []),
    ].every(Number.isFinite)).toBe(true);

    expect(Number.isFinite(result.totalGageRR)).toBe(true);
    expect(Number.isFinite(result.grandMean)).toBe(true);
    expect(Number.isFinite(result.ndc)).toBe(true);
    for (const component of result.components) {
      expect([
        component.variance,
        component.sd,
        component.studyVar,
        component.pctContribution,
        component.pctStudyVar,
      ].every(Number.isFinite)).toBe(true);
    }
  });
});
