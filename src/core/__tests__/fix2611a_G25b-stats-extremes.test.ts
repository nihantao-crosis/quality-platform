/**
 * fix2611a G25b-stats B2(附录 F.2-8):极端有限数残余——ANOVA 分组 σ 与 DOE 主效应/交互图均值。
 *
 * 约束:常规量级数据逐位不变(对拍 72409f1 的历史公式);只有位置/尺度比病态(>1e8)才走新路径。
 * 历史公式以逐字副本冻结在本文件里,只做差分参照;被测对象一律是真实生产函数。
 */
import { describe, expect, it } from 'vitest';
import { mean } from '../basicMath';
import { anovaGroupSummaries, oneWayAnova } from '../anova';
import {
  analyzeFactorial, detectFactorial, factorialAdjustedInteractionMeans, factorialAdjustedMainMeans,
  factorialCornerPredictions, type CodedDesign, type FactorialResult,
} from '../doe';

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function gaussian(random: () => number) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** 72409f1 anova.ts:127-128 的分组 σ 公式(逐字)。 */
function legacyGroupStDev(vals: number[]) {
  const m = mean(vals);
  return Math.sqrt(vals.reduce((sum, value) => sum + (value - m) ** 2, 0) / (vals.length - 1));
}

/** 72409f1 doe.ts:870-875 finiteMeanPreservingOrdinary(逐字)。 */
function legacyFiniteMean(values: number[]) {
  if (!values.length) return Number.NaN;
  let total = 0;
  for (const value of values) total += value;
  return Number.isFinite(total) ? total / values.length : mean(values);
}

/** 72409f1 常规分支:由(未改动的)角点预测取朴素均值。 */
function legacyMainMeans(result: FactorialResult, design: CodedDesign) {
  const corners = factorialCornerPredictions(result, design);
  return design.factorNames.map((name, index) => ({
    name,
    lo: legacyFiniteMean(corners.filter((corner) => corner.coded[index] < 0).map((corner) => corner.predicted)),
    hi: legacyFiniteMean(corners.filter((corner) => corner.coded[index] > 0).map((corner) => corner.predicted)),
  }));
}

function legacyInteractionMeans(result: FactorialResult, design: CodedDesign, i: number, j: number) {
  const corners = factorialCornerPredictions(result, design);
  const cell = (a: number, b: number) => legacyFiniteMean(corners
    .filter((corner) => corner.coded[i] === a && corner.coded[j] === b).map((corner) => corner.predicted));
  return { c00: cell(-1, -1), c10: cell(1, -1), c01: cell(-1, 1), c11: cell(1, 1) };
}

describe('B2 ANOVA 分组标准差', () => {
  const groups = [[2, 4, 6, 8], [10, 12, 14, 18], [4, 6, 2, 10]];

  it('同一组数据加 1e6/1e12/1e16 后分组 σ 不变(HEAD 在 1e16 处相对误差约 10%)', () => {
    const toSummaries = (shift: number) => {
      const named = groups.map((vals, index) => ({ name: `组${index + 1}`, vals: vals.map((value) => value + shift) }));
      return anovaGroupSummaries(named, oneWayAnova(named.map((group) => group.vals)));
    };
    const base = toSummaries(0);
    for (const shift of [1e6, 1e12, 1e16]) {
      const shifted = toSummaries(shift);
      shifted.forEach((summary, index) => {
        expect(Math.abs(summary.stDev - base[index].stDev) / base[index].stDev, `shift=${shift} 组${index + 1}`)
          .toBeLessThan(1e-12);
        // 均值本身只能取最接近的 double(1e16 处 ulp=2)
        expect(Math.abs(summary.mean - shift - base[index].mean)).toBeLessThanOrEqual(1);
      });
    }
  });

  it('常规量级分组 σ、均值、置信区间与 72409f1 逐位一致(≥5000 组对拍)', () => {
    const random = lcg(2611_0825);
    const locations = [0, 1, 10, 25.4, -80, 500, 1e4, 1e5];
    const spreads = [1e-3, 0.05, 1, 20];
    let compared = 0;
    const mismatches: string[] = [];
    for (let trial = 0; trial < 2400; trial++) {
      const k = 2 + (trial % 4);
      const location = locations[trial % locations.length];
      const spread = spreads[Math.floor(trial / locations.length) % spreads.length];
      const named = Array.from({ length: k }, (_, index) => ({
        name: `g${index}`,
        vals: Array.from({ length: 2 + Math.floor(random() * 12) },
          () => Math.round((location + index * spread * 0.3 + spread * gaussian(random)) * 1e4) / 1e4),
      }));
      if (named.some((group) => new Set(group.vals).size < 2)) continue;
      // 只对拍常规量级:位置/尺度比离 1e8 阈值还有一个数量级以上
      if (named.some((group) => Math.abs(mean(group.vals)) / legacyGroupStDev(group.vals) > 1e7)) continue;
      const summaries = anovaGroupSummaries(named, oneWayAnova(named.map((group) => group.vals)));
      summaries.forEach((summary, index) => {
        compared++;
        const expected = legacyGroupStDev(named[index].vals);
        if (!Object.is(summary.stDev, expected)) mismatches.push(`#${trial}/${index}: ${summary.stDev} ≠ ${expected}`);
        if (!Object.is(summary.mean, mean(named[index].vals))) mismatches.push(`#${trial}/${index} mean`);
      });
    }
    expect(compared).toBeGreaterThanOrEqual(5000);
    expect(mismatches.slice(0, 10)).toEqual([]);
  });
});

describe('B2 DOE 主效应/交互图均值', () => {
  const A = [-1, 1, -1, 1, -1, 1, -1, 1];
  const B = [-1, -1, 1, 1, -1, -1, 1, 1];
  const C = [-1, -1, -1, -1, 1, 1, 1, 1];
  const offsets = [6, 18, 10, 26, 14, 30, 22, 38]; // 偶整数:在 1e16 处可精确表示
  const terms = ['A', 'B', 'C', 'A×B'];

  function fit(shift: number, order: number[]) {
    const detected = detectFactorial([
      { name: 'A', values: order.map((row) => A[row]) },
      { name: 'B', values: order.map((row) => B[row]) },
      { name: 'C', values: order.map((row) => C[row]) },
    ], order.map((row) => offsets[row] + shift));
    if (!detected.ok) throw new Error(detected.reason);
    return { design: detected.design, result: analyzeFactorial(detected.design, { terms }) };
  }

  const identity = [0, 1, 2, 3, 4, 5, 6, 7];
  const shuffled = [5, 2, 7, 0, 3, 6, 1, 4];

  it('大基准(1e16、3e16+4)下主效应均值只经一次舍入,误差 ≤ ½ulp(HEAD 的 hi−lo 可从 7 变成 4)', () => {
    const reference = fit(0, identity);
    const exact = factorialAdjustedMainMeans(reference.result, reference.design);
    for (const shift of [1e16, 3e16 + 4]) {
      // 1e16 ∈ [2^53, 2^54):ulp=2;3e16 ∈ [2^54, 2^55):ulp=4。参照值本身有末位噪声,留 1e-9 余量
      const halfUlp = (shift >= 2 ** 54 ? 2 : 1) + 1e-9;
      const { design, result } = fit(shift, identity);
      const means = factorialAdjustedMainMeans(result, design);
      means.forEach((entry, index) => {
        expect(Math.abs((entry.lo - shift) - exact[index].lo), `${entry.name} 低水平 shift=${shift}`).toBeLessThanOrEqual(halfUlp);
        expect(Math.abs((entry.hi - shift) - exact[index].hi), `${entry.name} 高水平 shift=${shift}`).toBeLessThanOrEqual(halfUlp);
      });
      const cells = factorialAdjustedInteractionMeans(result, design, 0, 1);
      const exactCells = factorialAdjustedInteractionMeans(reference.result, reference.design, 0, 1);
      for (const key of ['c00', 'c10', 'c01', 'c11'] as const) {
        expect(Math.abs((cells[key] - shift) - exactCells[key]), `${key} shift=${shift}`).toBeLessThanOrEqual(halfUlp);
      }
    }
  });

  it('大基准下主效应/交互图均值与行序无关(逐位相同)', () => {
    for (const shift of [1e16, 3e16 + 4]) {
      const a = fit(shift, identity);
      const b = fit(shift, shuffled);
      expect(factorialAdjustedMainMeans(b.result, b.design)).toEqual(factorialAdjustedMainMeans(a.result, a.design));
      expect(factorialAdjustedInteractionMeans(b.result, b.design, 0, 2))
        .toEqual(factorialAdjustedInteractionMeans(a.result, a.design, 0, 2));
    }
  });

  it('常规量级(含区组、中心点)主效应/交互图均值与 72409f1 逐位一致', () => {
    const random = lcg(2611_0938);
    let compared = 0;
    const mismatches: string[] = [];
    for (let trial = 0; trial < 400; trial++) {
      const k = 2 + (trial % 3);
      const runs = 1 << k;
      const replicates = 1 + (trial % 2);
      const coded: number[][] = [];
      for (let rep = 0; rep < replicates; rep++) {
        for (let mask = 0; mask < runs; mask++) coded.push(Array.from({ length: k }, (_, j) => (mask >> j) & 1 ? 1 : -1));
      }
      const withCenter = trial % 5 === 0;
      if (withCenter) for (let c = 0; c < 3; c++) coded.push(Array(k).fill(0));
      const location = [0, 12.5, 300, -40, 8000, 2e5][trial % 6];
      const spread = [0.01, 0.5, 3, 40][trial % 4];
      const response = coded.map((row) => Math.round((location
        + spread * (row[0] * 1.3 - row[1] * 0.7 + row[0] * row[1] * 0.4 + gaussian(random) * 0.3)) * 1e3) / 1e3);
      const blocks = trial % 3 === 0 && replicates === 2 && !withCenter
        ? coded.map((_, row) => (row < runs ? '1' : '2'))
        : undefined;
      const detected = detectFactorial(
        Array.from({ length: k }, (_, j) => ({ name: String.fromCharCode(65 + j), values: coded.map((row) => row[j]) })),
        response,
        blocks ? { blocks } : {},
      );
      if (!detected.ok) continue;
      const result = analyzeFactorial(detected.design);
      compared++;
      const actual = factorialAdjustedMainMeans(result, detected.design);
      const expected = legacyMainMeans(result, detected.design);
      actual.forEach((entry, index) => {
        if (!Object.is(entry.lo, expected[index].lo) || !Object.is(entry.hi, expected[index].hi)) {
          mismatches.push(`#${trial} ${entry.name}: ${entry.lo}/${entry.hi} ≠ ${expected[index].lo}/${expected[index].hi}`);
        }
      });
      const cells = factorialAdjustedInteractionMeans(result, detected.design, 0, 1);
      const legacyCells = legacyInteractionMeans(result, detected.design, 0, 1);
      for (const key of ['c00', 'c10', 'c01', 'c11'] as const) {
        if (!Object.is(cells[key], legacyCells[key])) mismatches.push(`#${trial} ${key}`);
      }
    }
    expect(compared).toBeGreaterThanOrEqual(350);
    expect(mismatches.slice(0, 10)).toEqual([]);
  });
});
