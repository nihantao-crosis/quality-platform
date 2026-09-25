import { describe, expect, it } from 'vitest';
import { computeCapability } from '../capability';
import { generateFactorialDesign } from '../doe';
import { computeGageRR, type GageObservation } from '../gage';
import { linearRegression } from '../regression';

function relativeDifference(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected), Number.MIN_VALUE);
}

function expectFiniteNumbers(value: unknown): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value)).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(expectFiniteNumbers);
    return;
  }
  if (value && typeof value === 'object') Object.values(value).forEach(expectFiniteNumbers);
}

const factors = (count: number) => ['A', 'B', 'C', 'D'].slice(0, count)
  .map((name) => ({ name, low: -1, high: 1 }));

function factorialRuns(design: ReturnType<typeof generateFactorialDesign>, factorCount: number) {
  return design.rows
    .filter((_, index) => design.textCols[0].values[index] === '因子点')
    .map((row) => ({
      block: row[2],
      signs: row.slice(3, 3 + factorCount).map((value) => value > 0 ? 1 : -1),
    }));
}

function confoundedWords(
  runs: Array<{ block: number; signs: number[] }>,
  factorCount: number,
): string[] {
  const letters = ['A', 'B', 'C', 'D'];
  const byBlock = new Map<number, number[][]>();
  for (const run of runs) {
    const rows = byBlock.get(run.block) ?? [];
    rows.push(run.signs);
    byBlock.set(run.block, rows);
  }
  const words: string[] = [];
  for (let mask = 1; mask < (1 << factorCount); mask++) {
    const constantWithinEveryBlock = [...byBlock.values()].every((rows) => (
      new Set(rows.map((signs) => signs.reduce(
        (product, sign, index) => ((mask >> index) & 1) ? product * sign : product,
        1,
      ))).size === 1
    ));
    if (constantWithinEveryBlock) {
      words.push(letters.filter((_, index) => (mask >> index) & 1).join(''));
    }
  }
  return words;
}

describe('v1.43 统计与 DOE 数值修复', () => {
  it('2^3 × 2 仿行 × 2 区组优先按完整仿行分区，每块都有 8 个唯一角点', () => {
    const design = generateFactorialDesign(factors(3), {
      replicates: 2,
      blocks: 2,
      randomize: false,
    });
    const runs = factorialRuns(design, 3);
    for (const block of [1, 2]) {
      const blockRuns = runs.filter((run) => run.block === block);
      expect(blockRuns).toHaveLength(8);
      expect(new Set(blockRuns.map((run) => run.signs.join(','))).size).toBe(8);
    }

    // 同一规则适用于每块含多个完整仿行的情形。
    const fourReplicates = factorialRuns(generateFactorialDesign(factors(3), {
      replicates: 4,
      blocks: 2,
      randomize: false,
    }), 3);
    for (const block of [1, 2]) {
      const counts = new Map<string, number>();
      fourReplicates.filter((run) => run.block === block).forEach((run) => {
        const key = run.signs.join(',');
        counts.set(key, (counts.get(key) ?? 0) + 1);
      });
      expect(counts.size).toBe(8);
      expect([...counts.values()]).toEqual(Array(8).fill(2));
    }
  });

  it('4 因子 / 4 区组使用 Minitab 默认生成元 BC、ABD', () => {
    const design = generateFactorialDesign(factors(4), { blocks: 4, randomize: false });
    expect(confoundedWords(factorialRuns(design, 4), 4)).toEqual(['BC', 'ABD', 'ACD']);
  });

  it('回归的 SSE/SE/t/p 在平方和必然上溢或下溢的单位下仍与基线一致', () => {
    const xs = [1, 2, 3, 4, 5, 6];
    const ys = [2.1, 3.9, 6.2, 7.8, 10.3, 11.7];
    const baseline = linearRegression(xs, ys);
    const transforms = [
      { xScale: 2 ** -1000, yScale: 2 ** -1000 },
      { xScale: 2 ** 510, yScale: 2 ** 510 },
      { xScale: 2 ** 500, yScale: 2 ** -500 },
      { xScale: 2 ** -500, yScale: 2 ** 500 },
    ];

    for (const { xScale, yScale } of transforms) {
      const result = linearRegression(
        xs.map((value) => value * xScale),
        ys.map((value) => value * yScale),
      );
      const expectedSlope = baseline.slope * (yScale / xScale);
      const expectedSe = baseline.seSlope * (yScale / xScale);
      expect(relativeDifference(result.slope, expectedSlope)).toBeLessThan(2e-14);
      expect(relativeDifference(result.seSlope, expectedSe)).toBeLessThan(2e-14);
      expect(result.r2).toBeCloseTo(baseline.r2, 14);
      expect(result.t).toBeCloseTo(baseline.t, 13);
      expect(result.p).toBeCloseTo(baseline.p, 13);
      expect(result.significant).toBe(baseline.significant);
    }

    // 端点全部有限，但“端点 − 均值”已超出 Number 值域的边界。
    const maximum = Number.MAX_VALUE;
    const boundary = linearRegression([-maximum, maximum, maximum], [-maximum, maximum, maximum]);
    expect(boundary.slope).toBe(1);
    expect(boundary.intercept).toBe(0);
    expect(boundary.r2).toBe(1);
    expect(boundary.t).toBe(Infinity);
    expect(boundary.p).toBe(0);
  });

  it('Gage 无量纲结论不受 scale² 上溢/下溢影响', () => {
    const observations: GageObservation[] = [];
    const trialOffsets = [-0.2, 0, 0.3];
    for (let part = 0; part < 5; part++) {
      for (let operator = 0; operator < 2; operator++) {
        for (let trial = 0; trial < 3; trial++) {
          const interaction = (part % 2 === 0 ? 0.15 : -0.15) * (operator === 0 ? -1 : 1);
          observations.push({
            part,
            operator,
            trial,
            value: 10 + part * 5 + operator * 0.7 + interaction + trialOffsets[trial],
          });
        }
      }
    }
    const baseline = computeGageRR(observations, { mode: 'width', value: 100 });
    for (const unitScale of [2 ** -600, 2 ** 600]) {
      const transformed = computeGageRR(
        observations.map((row) => ({ ...row, value: row.value * unitScale })),
        { mode: 'width', value: 100 * unitScale },
      );
      expect(transformed.totalGageRR).toBeCloseTo(baseline.totalGageRR, 12);
      expect(transformed.ndc).toBe(baseline.ndc);
      expect(transformed.verdict).toBe(baseline.verdict);
      expect(transformed.interaction!.fStat).toBeCloseTo(baseline.interaction!.fStat, 12);
      expect(transformed.interaction!.pValue).toBeCloseTo(baseline.interaction!.pValue, 12);
      transformed.components.forEach((component, index) => {
        const expected = baseline.components[index];
        expect(component.key).toBe(expected.key);
        expect(component.pctContribution).toBeCloseTo(expected.pctContribution, 12);
        expect(component.pctStudyVar).toBeCloseTo(expected.pctStudyVar, 12);
        expect(component.pctTolerance).toBeCloseTo(expected.pctTolerance!, 12);
      });
    }
  });

  it('能力指数避免规格宽、3σ、6σ中间溢出，且所有数值字段有限', () => {
    const extreme = computeCapability(
      [0, 5e307, 1e308],
      5e307,
      { lsl: -1e308, tgt: 5e307, usl: 1.5e308 },
    );
    expect(extreme.cp).toBeCloseTo(5 / 6, 12);
    expect(extreme.cpk).toBeCloseTo(2 / 3, 12);
    expect(extreme.pp).toBeCloseTo(5 / 6, 12);
    expect(extreme.ppk).toBeCloseTo(2 / 3, 12);
    expect(extreme.cpm).toBeCloseTo(Math.sqrt(2 / 3), 12);
    expectFiniteNumbers(extreme);

    // 真实比值超出 Number 值域时饱和到最大有限数，不污染报告。
    const saturated = computeCapability(
      [-1, 0, 1],
      Number.MIN_VALUE,
      { lsl: -2, tgt: 0, usl: 2 },
    );
    expect(saturated.cp).toBe(Number.MAX_VALUE);
    expect(saturated.cpk).toBe(Number.MAX_VALUE);
    expectFiniteNumbers(saturated);
  });
});
