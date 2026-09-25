import { describe, expect, it } from 'vitest';
import { computeDescriptive } from '../descriptive';
import { analyzeGeneralFactorial, detectGeneralFactorial } from '../doe';
import { linearRegression } from '../regression';

const regressionX = [0, 2, 4, 8, 10, 14];
const regressionY = [
  0.06573270726948977,
  0.4467036931402981,
  0.41696030043065546,
  0.27621028250083324,
  0.5926156451925635,
  1.7089500975050032,
];

function generalFactorial(scale = 1) {
  const a: number[] = [];
  const b: number[] = [];
  const response: number[] = [];
  for (let ai = 0; ai < 3; ai += 1) {
    for (let bi = 0; bi < 2; bi += 1) {
      for (const error of [-0.2, 0.2]) {
        a.push(ai);
        b.push(bi);
        response.push((10 + 2 * ai + 3 * bi + 0.3 * ai * bi + error) * scale);
      }
    }
  }
  const detected = detectGeneralFactorial([
    { name: 'A', values: a },
    { name: 'B', values: b },
  ], response);
  if (!detected.ok) throw new Error(detected.reason);
  return analyzeGeneralFactorial(detected.design);
}

describe('最终统计数值反例', () => {
  it('回归对可精确表示的大常数 X 平移保持全部推断量', () => {
    const baseline = linearRegression(regressionX, regressionY);
    const translated = linearRegression(regressionX.map((value) => 1e16 + value), regressionY);

    expect(baseline.slope).toBeCloseTo(0.08906910095760448, 15);
    expect(baseline.r2).toBeCloseTo(0.6596594870550979, 15);
    expect(baseline.p).toBeCloseTo(0.04959445530494935, 15);
    expect(baseline.significant).toBe(true);
    expect(translated.slope).toBe(baseline.slope);
    expect(translated.r).toBe(baseline.r);
    expect(translated.r2).toBe(baseline.r2);
    expect(translated.seSlope).toBe(baseline.seSlope);
    expect(translated.t).toBe(baseline.t);
    expect(translated.p).toBe(baseline.p);
    expect(translated.significant).toBe(baseline.significant);
  });

  it('回归对真实斜率超出 Number 可表示范围的病态单位明确拒绝', () => {
    expect(() => linearRegression(
      [1e100, 2e100, 3e100],
      [1e-300, 2e-300, 3e-300],
    )).toThrow('斜率在当前 X/Y 单位下溢');
  });

  it('一般全因子的普通尺度黄金值保持不变', () => {
    const result = generalFactorial();
    const row = (name: string) => result.rows.find((item) => item.name === name)!;
    expect(row('A').adjSS).toBeCloseTo(36.98, 12);
    expect(row('A').f).toBeCloseTo(231.125, 10);
    expect(row('A').p).toBeCloseTo(0.000002103877228432083, 15);
    expect(row('B').adjSS).toBeCloseTo(32.67, 12);
    expect(row('A×B').adjSS).toBeCloseTo(0.18, 12);
    expect(row('A×B').p).toBeCloseTo(0.38467317806160417, 14);
    expect(row('A×B').sig).toBe(false);
    expect(result.error.adjSS).toBeCloseTo(0.48, 12);
    expect(result.total.adjSS).toBeCloseTo(70.31, 12);
    expect(result.r2).toBeCloseTo(0.9931730905987769, 14);
  });

  it('一般全因子在响应平方上溢/下溢单位下保持 F/P/显著性/R²，展示 SS 也为有限数', () => {
    const baseline = generalFactorial();
    for (const scale of [1e200, 1e-200]) {
      const transformed = generalFactorial(scale);
      expect(transformed.r2).toBeCloseTo(baseline.r2, 14);
      expect(transformed.r2Adj).toBeCloseTo(baseline.r2Adj!, 14);
      transformed.rows.forEach((row, index) => {
        const expected = baseline.rows[index];
        expect(row.name).toBe(expected.name);
        expect(row.f).toBeCloseTo(expected.f!, 11);
        expect(row.p).toBeCloseTo(expected.p!, 14);
        expect(row.sig).toBe(expected.sig);
        expect(Number.isFinite(row.adjSS)).toBe(true);
        expect(Number.isFinite(row.adjMS!)).toBe(true);
      });
      expect(Number.isFinite(transformed.error.adjSS)).toBe(true);
      expect(Number.isFinite(transformed.error.adjMS!)).toBe(true);
      expect(Number.isFinite(transformed.total.adjSS)).toBe(true);
    }
  });

  it('描述统计的偏度/峰度在普通、极大和极小单位下同源', () => {
    const baseline = computeDescriptive([-3, -1, 1, 3]);
    expect(baseline.skewness).toBe(0);
    expect(baseline.kurtosis).toBeCloseTo(-1.2, 14);
    for (const scale of [1e100, 1e-100]) {
      const transformed = computeDescriptive([-3, -1, 1, 3].map((value) => value * scale));
      expect(transformed.skewness).toBeCloseTo(baseline.skewness, 14);
      expect(transformed.kurtosis).toBeCloseTo(baseline.kurtosis, 14);
    }
  });
});
