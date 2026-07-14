/**
 * 分阶段控制图对拍 — 段切分/段内限值/段内判异。
 */
import { describe, it, expect } from 'vitest';
import { splitStages, stagedXbar, stagedRange } from '../stages';
import { CONTROL_CONSTANTS, DEFAULT_RULES } from '../spc';

const RULES = DEFAULT_RULES;

describe('splitStages', () => {
  it('连续段切分与不连续同名标签', () => {
    expect(splitStages(['A', 'A', 'B', 'B', 'A'])).toEqual([
      { label: 'A', start: 0, end: 1 },
      { label: 'B', start: 2, end: 3 },
      { label: 'A', start: 4, end: 4 },
    ]);
  });
});

describe('stagedXbar', () => {
  // 两段:前段均值 10,后段均值 20（n=2 子组）
  const rows = [
    [9.9, 10.1], [10.0, 10.2], [9.8, 10.0], [10.1, 10.1],
    [19.9, 20.1], [20.0, 20.2], [19.8, 20.0], [20.1, 20.1],
  ];
  const labels = ['改进前', '改进前', '改进前', '改进前', '改进后', '改进后', '改进后', '改进后'];
  const r = stagedXbar(rows, labels, RULES);

  it('两段独立中心线(≈10 与 ≈20)', () => {
    expect(r.segments.length).toBe(2);
    expect(r.segments[0].cl).toBeCloseTo(10.025, 3);
    expect(r.segments[1].cl).toBeCloseTo(20.025, 3);
    expect(r.boundaries).toEqual([4]);
  });
  it('限值序列与段对齐,公式 X̿ ± A2·R̄(段内)', () => {
    const C = CONTROL_CONSTANTS[2];
    const seg0Rbar = (0.2 + 0.2 + 0.2 + 0.0) / 4;
    expect(r.uclSeries[0]).toBeCloseTo(r.segments[0].cl + C.A2 * seg0Rbar, 10);
    expect(r.clSeries[3]).toBeCloseTo(r.segments[0].cl, 10);
    expect(r.clSeries[4]).toBeCloseTo(r.segments[1].cl, 10);
  });
  it('段内无失控（各段稳定,跨段跳变不误报）', () => {
    // 整体判异会把后段全部判失控;分段后应无失控
    expect(r.viol.size).toBe(0);
  });
  it('段内漂移仍能检出', () => {
    const rows2 = rows.map((row, i) => (i === 2 ? [30, 30.2] : row)); // 前段插入异常点
    const r2 = stagedXbar(rows2, labels, RULES);
    expect([...r2.viol]).toContain(2);
  });
});

describe('stagedRange', () => {
  it('R 图段内 UCL = D4·R̄', () => {
    const rows = [
      [1, 2], [1, 2], [1, 2],
      [5, 9], [5, 9], [5, 9],
    ];
    const labels = ['a', 'a', 'a', 'b', 'b', 'b'];
    const r = stagedRange(rows, labels, RULES);
    const C = CONTROL_CONSTANTS[2];
    expect(r.segments[0].cl).toBeCloseTo(1, 10);
    expect(r.segments[0].ucl).toBeCloseTo(C.D4 * 1, 10);
    expect(r.segments[1].cl).toBeCloseTo(4, 10);
  });
});
