import { describe, expect, it } from 'vitest';
import { mean, rootMeanSquare, stdev } from '../basicMath';
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
