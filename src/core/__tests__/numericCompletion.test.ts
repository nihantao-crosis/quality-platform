import { describe, expect, it } from 'vitest';
import {
  analyzeDoe,
  analyzeFactorial,
  factorialAdjustedInteractionMeans,
  factorialAdjustedMainMeans,
  factorialCornerPredictions,
  interactionMeansFrom,
  mainEffectMeansFrom,
  type CodedDesign,
} from '../doe';
import { stagedRange, stagedXbar, type StagedResult } from '../stages';
import type { NelsonRules } from '../spc';

const MAXIMUM = Number.MAX_VALUE;
const ALL_RULES: NelsonRules = {
  r1: true, r2: true, r3: true, r4: true,
  r5: true, r6: true, r7: true, r8: true,
};

const CODED_23 = [
  [-1, -1, -1],
  [1, -1, -1],
  [-1, 1, -1],
  [1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [-1, 1, 1],
  [1, 1, 1],
];

function expectFiniteStages(result: StagedResult): void {
  expect([
    ...result.clSeries,
    ...result.uclSeries,
    ...result.lclSeries,
    ...result.segments.flatMap((segment) => [segment.cl, segment.ucl, segment.lcl, segment.sigma]),
  ].every(Number.isFinite)).toBe(true);
}

function twoLevelDesign(coded: number[][], response: number[]): CodedDesign {
  const factorCount = coded[0].length;
  return {
    factorNames: Array.from({ length: factorCount }, (_, index) => String.fromCharCode(65 + index)),
    coded,
    response,
    levels: Array.from({ length: factorCount }, () => ({ low: 0, high: 1, hasCenter: false })),
  };
}

describe('数值极值补齐', () => {
  it('classic/pooled 分阶段 Xbar/R 在共同坐标域判异并有限恢复', () => {
    const rows = [
      [-MAXIMUM, MAXIMUM],
      [0, 0],
      [0, 0],
      [0, 0],
      [-MAXIMUM, MAXIMUM],
      [MAXIMUM, -MAXIMUM],
      [0, 0],
      [0, 0],
    ];
    const labels = ['阶段1', '阶段1', '阶段1', '阶段1', '阶段2', '阶段2', '阶段2', '阶段2'];

    for (const method of ['classic', 'pooled'] as const) {
      expectFiniteStages(stagedXbar(rows, labels, ALL_RULES, method));
      const range = stagedRange(rows, labels, ALL_RULES, method);
      expectFiniteStages(range);
      expect(range.segments[0].cl).toBeGreaterThan(0);
      expect(range.segments[0].ucl).toBeGreaterThanOrEqual(range.segments[0].cl);
    }
  });

  it('2^3 极值探针的效应、角点、调整主效应与交互均为有限值', () => {
    const response = [-17, 10, 17, -15, -15, 0, -5, 5].map((value) => value * 1e307);
    const design = twoLevelDesign(CODED_23, response);
    const compact = analyzeDoe(response);
    const result = analyzeFactorial(design);
    const corners = factorialCornerPredictions(result, design);
    const adjustedMain = factorialAdjustedMainMeans(result, design);
    const adjustedInteraction = factorialAdjustedInteractionMeans(result, design, 0, 1);
    const rawMain = mainEffectMeansFrom(design);
    const rawInteraction = interactionMeansFrom(design, 0, 1);

    expect([
      compact.pse,
      compact.me,
      ...compact.terms.flatMap((term) => [term.v, term.abs, term.coef]),
      result.grand,
      ...(result.pse == null ? [] : [result.pse]),
      ...(result.me == null ? [] : [result.me]),
      ...result.terms.flatMap((term) => [term.effect, term.coef]),
      ...result.fits,
      ...result.residuals,
      ...corners.map((corner) => corner.predicted),
      ...adjustedMain.flatMap((entry) => [entry.lo, entry.hi]),
      ...Object.values(adjustedInteraction),
      ...rawMain.flatMap((entry) => [entry.lo, entry.hi]),
      ...Object.values(rawInteraction),
    ].every(Number.isFinite)).toBe(true);
  });

  it('有残差自由度的极值响应把 MSE 恢复为有限饱和值', () => {
    const base = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    const response = [-0.9, -0.2, 0.2, 0.7, -0.7, 0, 0.4, 0.9]
      .map((value) => value * MAXIMUM);
    const design = twoLevelDesign([...base, ...base], response);
    const result = analyzeFactorial(design);

    expect(result.dfResid).toBe(4);
    expect(result.mse).toBe(MAXIMUM);
    expect(result.mse).toBeGreaterThan(0);
    expect([
      ...result.terms.flatMap((term) => [term.effect, term.coef]),
      ...result.fits,
      ...result.residuals,
      ...factorialCornerPredictions(result, design).map((corner) => corner.predicted),
    ].every(Number.isFinite)).toBe(true);
  });
});
