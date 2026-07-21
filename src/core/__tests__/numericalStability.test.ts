import { describe, expect, it } from 'vitest';
import { mean, rootMeanSquare, stableSum, stdev } from '../basicMath';
import { computeCapability } from '../capability';
import { computeGagePanelData, computeGageRR, type GageObservation } from '../gage';
import { computeVarModel } from '../model';
import { CONTROL_CONSTANTS, type NelsonRules } from '../spc';
import { stagedXbar } from '../stages';

const BASE = 1e9;
const LOW = BASE - 5e-6;
const HIGH = BASE + 5e-6;
const BLOCKED = [...Array(50).fill(LOW), ...Array(450).fill(HIGH)] as number[];
const INTERLEAVED = Array.from({ length: 500 }, (_, index) => index % 10 === 0 ? LOW : HIGH);
const REVERSED = [...BLOCKED].reverse();

function legacyStdev(values: number[]): number {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function relativeDifference(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
}

const NO_RULES: NelsonRules = {
  r1: false, r2: false, r3: false, r4: false,
  r5: false, r6: false, r7: false, r8: false,
};

describe('审计级数值稳定性回归', () => {
  it('均值保留大数相消后的低位，且不随排列改变', () => {
    const permutations = (magnitude: number): number[][] => [
      [magnitude, -magnitude, 1],
      [magnitude, 1, -magnitude],
      [-magnitude, magnitude, 1],
      [-magnitude, 1, magnitude],
      [1, magnitude, -magnitude],
      [1, -magnitude, magnitude],
    ];

    for (const magnitude of [1e16, 1e308]) {
      const results = permutations(magnitude).map((values) => mean(values));
      expect(new Set(results).size).toBe(1);
      results.forEach((result) => expect(result).toBeCloseTo(1 / 3, 15));
    }

    // 补偿相消不能以牺牲既有的大基准微扰精度为代价。
    const local = [1e15 - 1, 1e15, 1e15 + 1];
    expect(mean(local)).toBe(1e15);
    expect(stdev(local)).toBe(1);
  });

  it('多层量级相消也保留最后残量，均值与求和不随排列改变', () => {
    const high = 2 ** 108;
    const middle = 2 ** 54;
    const values = [high, -high, middle, -middle, -1];
    const permutations = (items: number[]): number[][] => items.length <= 1
      ? [items]
      : items.flatMap((value, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)])
          .map((tail) => [value, ...tail]));

    for (const arranged of permutations(values)) {
      expect(stableSum(arranged)).toBe(-1);
      expect(mean(arranged)).toBe(-0.2);
    }
  });

  it('真实总和溢出但均值/标准差可表示时仍返回有限正确值', () => {
    const values = [-4e307, ...Array(10).fill(4e307)] as number[];
    const expectedMean = (36 / 11) * 1e307;
    const expectedStdev = (8 / Math.sqrt(11)) * 1e307;
    for (const arranged of [values, [...values].reverse()]) {
      const actualMean = mean(arranged);
      const actualStdev = stdev(arranged);
      expect(Number.isFinite(actualMean)).toBe(true);
      expect(Number.isFinite(actualStdev)).toBe(true);
      expect(relativeDifference(actualMean, expectedMean)).toBeLessThan(2e-15);
      expect(relativeDifference(actualStdev, expectedStdev)).toBeLessThan(2e-15);
    }
  });

  it('空样本与非有限观测明确传播 NaN，不误报零方差', () => {
    expect(mean([])).toBeNaN();
    expect(stdev([])).toBeNaN();
    expect(stdev([], false)).toBeNaN();
    expect(stdev([1])).toBeNaN();
    expect(stdev([1], false)).toBe(0);
    for (const invalid of [
      [Number.NaN, 1],
      [Number.POSITIVE_INFINITY, 1],
      [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    ]) {
      expect(stdev(invalid)).toBeNaN();
      expect(stdev(invalid, false)).toBeNaN();
    }
  });

  it('固定 500 点反例：旧朴素二遍法高估约 73.08%，模型结果与排列无关', () => {
    // 期望值按 JavaScript 实际可表示的 LOW/HIGH 两点及 50/450 频数计算。
    const expected = 3.007082684410897e-6;
    const stable = stdev(BLOCKED);
    expect(stable).toBeCloseTo(expected, 15);
    expect(legacyStdev(BLOCKED) / stable - 1).toBeCloseTo(0.730814, 6);

    const models = [BLOCKED, INTERLEAVED, REVERSED].map((values) =>
      computeVarModel('大基准.csv', ['测量值'], values.map((value) => [value])));
    for (const model of models) {
      expect(model.oMean).toBe(mean(BLOCKED));
      expect(relativeDifference(model.oSd, expected)).toBeLessThan(1e-12);
    }
  });

  it('能力结果对同一多重集的排列不敏感，且平移/缩放保持统计口径', () => {
    const spec = { lsl: BASE - 20e-6, tgt: BASE, usl: BASE + 20e-6 };
    const results = [BLOCKED, INTERLEAVED, REVERSED].map((values) =>
      computeCapability(values, 1e-6, spec));
    for (const result of results.slice(1)) {
      expect(result.mean).toBe(results[0].mean);
      expect(relativeDifference(result.sigmaOverall, results[0].sigmaOverall)).toBeLessThan(1e-12);
      expect(result.cpk).toBe(results[0].cpk);
      expect(relativeDifference(result.ppk, results[0].ppk)).toBeLessThan(1e-12);
      expect(relativeDifference(result.cpm!, results[0].cpm!)).toBeLessThan(1e-12);
      expect(result.verdict).toBe(results[0].verdict);
    }

    const source = [-4, -1, 0, 2, 8];
    const base = computeCapability(source, 2, { lsl: -10, tgt: 0, usl: 10 });
    const shifted = computeCapability(
      source.map((value) => value + 1e12),
      2,
      { lsl: 1e12 - 10, tgt: 1e12, usl: 1e12 + 10 },
    );
    const scaled = computeCapability(
      source.map((value) => value * 1000),
      2000,
      { lsl: -10000, tgt: 0, usl: 10000 },
    );
    for (const transformed of [shifted, scaled]) {
      expect(transformed.cp).toBeCloseTo(base.cp!, 12);
      expect(transformed.cpk).toBeCloseTo(base.cpk, 12);
      expect(transformed.pp).toBeCloseTo(base.pp!, 12);
      expect(transformed.ppk).toBeCloseTo(base.ppk, 12);
      expect(transformed.cpm).toBeCloseTo(base.cpm!, 12);
      expect(transformed.verdict).toBe(base.verdict);
    }

    const rows = [[-4, -3, -2], [-1, 0, 1], [2, 3, 4], [5, 6, 7]];
    const model = computeVarModel('原单位', ['x1', 'x2', 'x3'], rows);
    const offset = 2 ** 40;
    const shiftedModel = computeVarModel(
      '平移',
      ['x1', 'x2', 'x3'],
      rows.map((row) => row.map((value) => value + offset)),
    );
    const scale = 2 ** 10;
    const scaledModel = computeVarModel(
      '换单位',
      ['x1', 'x2', 'x3'],
      rows.map((row) => row.map((value) => value * scale)),
    );
    expect(shiftedModel.oMean - offset).toBe(model.oMean);
    expect(shiftedModel.oSd).toBe(model.oSd);
    expect(shiftedModel.xbarbar - offset).toBe(model.xbarbar);
    expect(shiftedModel.rbar).toBe(model.rbar);
    expect(scaledModel.oMean).toBe(model.oMean * scale);
    expect(scaledModel.oSd).toBe(model.oSd * scale);
    expect(scaledModel.xbarbar).toBe(model.xbarbar * scale);
    expect(scaledModel.rbar).toBe(model.rbar * scale);
  });

  it('Cpm 使用缩放均方根，极端量纲不因直接平方而溢出或下溢', () => {
    expect(rootMeanSquare([3e200, 4e200])).toBeCloseTo(Math.sqrt(12.5) * 1e200, 12);
    expect(rootMeanSquare([3e-200, 4e-200])).toBeCloseTo(Math.sqrt(12.5) * 1e-200, 12);
    const huge = computeCapability(
      [1e200, 2e200, 3e200],
      1e200,
      { lsl: 0, tgt: 2e200, usl: 4e200 },
    );
    const tiny = computeCapability(
      [1e-200, 2e-200, 3e-200],
      1e-200,
      { lsl: 0, tgt: 2e-200, usl: 4e-200 },
    );
    expect(huge.cpm).toBeCloseTo(Math.sqrt(2 / 3), 12);
    expect(tiny.cpm).toBeCloseTo(Math.sqrt(2 / 3), 12);
  });

  it('分阶段 Xbar 中心线和限值不随段内子组排列改变', () => {
    const makeRows = (values: number[], offset = 0) => values.map((value) => [
      value + offset - 1e-6,
      value + offset + 1e-6,
    ]);
    const orderedRows = [...makeRows(BLOCKED), ...makeRows(BLOCKED, 1e-4)];
    const permutedRows = [...makeRows(REVERSED), ...makeRows(INTERLEAVED, 1e-4)];
    const labels = [...Array(500).fill('A'), ...Array(500).fill('B')] as string[];
    const ordered = stagedXbar(orderedRows, labels, NO_RULES, 'pooled');
    const permuted = stagedXbar(permutedRows, labels, NO_RULES, 'pooled');
    ordered.segments.forEach((segment, index) => {
      expect(segment.cl).toBe(permuted.segments[index].cl);
      expect(relativeDifference(segment.sigma, permuted.segments[index].sigma)).toBeLessThan(1e-12);
      expect(segment.ucl).toBe(permuted.segments[index].ucl);
      expect(segment.lcl).toBe(permuted.segments[index].lcl);
    });
  });

  it('Gage 面板中心与主结果同源，观测行重排不改变图形统计量或 ANOVA 结论', () => {
    const observations: GageObservation[] = [];
    for (let part = 0; part < 10; part++) {
      for (let operator = 0; operator < 5; operator++) {
        for (let trial = 0; trial < 10; trial++) {
          observations.push({ part, operator, trial, value: trial === 0 ? LOW : HIGH });
        }
      }
    }
    const reversed = [...observations].reverse();
    const main = computeGageRR(observations, { mode: 'width', value: 1e-3 });
    const mainReversed = computeGageRR(reversed, { mode: 'width', value: 1e-3 });
    const panel = computeGagePanelData(observations, CONTROL_CONSTANTS[10]);
    const panelReversed = computeGagePanelData(reversed, CONTROL_CONSTANTS[10]);

    expect(panel.grandMean).toBe(main.grandMean);
    expect(panelReversed.grandMean).toBe(mainReversed.grandMean);
    expect(panelReversed.grandMean).toBe(panel.grandMean);
    expect(panelReversed.cellMeans).toEqual(panel.cellMeans);
    expect(panelReversed.partMeans).toEqual(panel.partMeans);
    expect(panelReversed.operatorMeans).toEqual(panel.operatorMeans);
    expect(panelReversed.rBar).toBe(panel.rBar);
    expect(panel.xbarLimits!.cl).toBe(main.grandMean);
    expect(mainReversed.totalGageRR).toBeCloseTo(main.totalGageRR, 12);
    mainReversed.components.forEach((component, index) => {
      expect(component.variance).toBeCloseTo(main.components[index].variance, 12);
    });
  });
});
