/**
 * fix2611a G25b-stats B1(附录 F.2-4):Anderson–Darling 平移不变性。
 *
 * 约束:常规量级数据的 A²/A*²/P/判定必须与 72409f1 的历史实现逐位一致;
 * 只有位置/尺度比病态(|均值|/σ > 1e8)时才走中心化路径。
 * 下方 `legacyAndersonDarling` 是 72409f1 `src/core/normality.ts` 的逐字冻结副本,
 * 只用于差分对拍;被测对象是真实生产函数 andersonDarling / evaluateAndersonDarling。
 */
import { describe, expect, it } from 'vitest';
import { mean, phi, stdev } from '../basicMath';
import { andersonDarling, evaluateAndersonDarling } from '../normality';

function legacyAndersonDarling(xs: number[], presorted = false) {
  const n = xs.length;
  const m = mean(xs);
  const s = stdev(xs, true);
  if (!(s > 0) || !Number.isFinite(s)) throw new Error('legacy: non-positive sd');
  const z = (presorted ? xs : [...xs].sort((a, b) => a - b)).map((x) => (x - m) / s);
  const EPS = 1e-12;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const Fi = Math.min(1 - EPS, Math.max(EPS, phi(z[i])));
    const Fni = Math.min(1 - EPS, Math.max(EPS, phi(z[n - 1 - i])));
    sum += (2 * i + 1) * (Math.log(Fi) + Math.log(1 - Fni));
  }
  const a2 = -n - sum / n;
  const a2star = a2 * (1 + 0.75 / n + 2.25 / (n * n));
  let p: number;
  if (a2star >= 0.6) {
    const tailTurningPoint = 5.709 / (2 * 0.0186);
    const tailStatistic = Math.min(a2star, tailTurningPoint);
    p = Math.exp(1.2937 - 5.709 * tailStatistic + 0.0186 * tailStatistic * tailStatistic);
  }
  else if (a2star > 0.34) p = Math.exp(0.9177 - 4.279 * a2star - 1.38 * a2star * a2star);
  else if (a2star > 0.2) p = 1 - Math.exp(-8.318 + 42.796 * a2star - 59.938 * a2star * a2star);
  else p = 1 - Math.exp(-13.436 + 101.14 * a2star - 223.73 * a2star * a2star);
  p = Math.min(1, Math.max(0, p));
  return { a2, a2star, p, normal: p >= 0.05, n };
}

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

/** 同一组「可在 1e16 处精确表示」的离差:偶整数(1e16 处 ulp=2)。 */
function evenDeviations(random: () => number, n: number, spread: number) {
  return Array.from({ length: n }, () => 2 * Math.round(gaussian(random) * spread));
}

describe('B1 Anderson–Darling 平移不变性', () => {
  it('同一组离差加 0/1e6/1e12/1e16:判定一致、P 一致(病态区间内逐位相同)', () => {
    const random = lcg(20261114);
    let checked = 0;
    let decisionFlips = 0;
    let maxPDiff = 0;
    let illConditionedMismatch = 0;
    for (let trial = 0; trial < 3000; trial++) {
      const n = 8 + Math.floor(random() * 60);
      const spread = [3, 10, 100][trial % 3];
      const deviations = evenDeviations(random, n, spread);
      if (new Set(deviations).size < 2) continue;
      checked++;
      const base = andersonDarling(deviations);
      const shifted = [1e6, 1e12, 1e16].map((shift) => andersonDarling(deviations.map((value) => value + shift)));
      for (const result of shifted) {
        if (result.normal !== base.normal) decisionFlips++;
        maxPDiff = Math.max(maxPDiff, Math.abs(result.p - base.p));
      }
      // 1e12 与 1e16 都落在病态区间(|均值|/σ > 1e8),走同一中心化路径,应逐位相同
      if (!Object.is(shifted[1].a2, shifted[2].a2) || !Object.is(shifted[1].p, shifted[2].p)) illConditionedMismatch++;
    }
    expect(checked).toBeGreaterThan(2500);
    expect(decisionFlips, '加常数后正态判定翻转').toBe(0);
    expect(maxPDiff, '加常数后 P 值漂移').toBeLessThan(1e-9);
    expect(illConditionedMismatch, '病态区间内 1e12 与 1e16 平移结果不逐位相同').toBe(0);
  });

  it('报告安全入口同样平移不变(下游能力综合等级的正态判定来源)', () => {
    const deviations = [0, 2, -2, 4, -4, 6, 2, -6, 0, 8, -2, 10];
    const base = evaluateAndersonDarling(deviations).result!;
    const shifted = evaluateAndersonDarling(deviations.map((value) => value + 1e16)).result!;
    expect(shifted.normal).toBe(base.normal);
    expect(Math.abs(shifted.p - base.p)).toBeLessThan(1e-12);
    expect(Math.abs(shifted.a2 - base.a2)).toBeLessThan(1e-12);
  });

  it('常规量级数据与 72409f1 历史实现逐位一致(≥5000 组差分对拍)', () => {
    const random = lcg(7_202_611);
    const locations = [0, 1, -3.5, 10, 25.4, 100, -250, 1000, 1e4, 1e5];
    const spreads = [1e-3, 0.01, 0.1, 1, 10, 100];
    let compared = 0;
    let presortedCompared = 0;
    const mismatches: string[] = [];
    for (let trial = 0; trial < 6000; trial++) {
      const n = 8 + Math.floor(random() * 150);
      const location = locations[trial % locations.length];
      const spread = spreads[Math.floor(trial / locations.length) % spreads.length];
      const shape = trial % 5;
      const xs = Array.from({ length: n }, () => {
        const draw = shape === 0 ? gaussian(random)
          : shape === 1 ? random() - 0.5
            : shape === 2 ? -Math.log(1 - random())
              : shape === 3 ? Math.exp(gaussian(random))
                : Math.round(gaussian(random) * 1000) / 1000; // 工厂常见的 3 位小数记录
        return location + spread * draw;
      });
      const s = stdev(xs, true);
      if (!(s > 0)) continue;
      // 只对拍常规量级:位置/尺度比离 1e8 阈值还有一个数量级以上
      if (Math.abs(mean(xs)) / s > 1e7) continue;
      compared++;
      const expected = legacyAndersonDarling(xs);
      const actual = andersonDarling(xs);
      for (const key of ['a2', 'a2star', 'p', 'normal', 'n'] as const) {
        if (!Object.is(actual[key], expected[key])) mismatches.push(`#${trial} ${key}: ${actual[key]} ≠ ${expected[key]}`);
      }
      if (trial % 4 === 0) {
        const sorted = [...xs].sort((a, b) => a - b);
        presortedCompared++;
        const expectedSorted = legacyAndersonDarling(sorted, true);
        const actualSorted = andersonDarling(sorted, true);
        if (!Object.is(actualSorted.a2, expectedSorted.a2) || !Object.is(actualSorted.p, expectedSorted.p)) {
          mismatches.push(`#${trial} presorted`);
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(5000);
    expect(presortedCompared).toBeGreaterThan(1000);
    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  it('严格入口的抛错契约不变', () => {
    expect(() => andersonDarling([1, 2, 3])).toThrow(/至少需要 8 个观测/);
    expect(() => andersonDarling(Array(10).fill(1e16))).toThrow(/正的有限标准差/);
  });
});
