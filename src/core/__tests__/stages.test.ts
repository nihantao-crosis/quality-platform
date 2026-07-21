/**
 * 分阶段控制图对拍 — 段切分/段内限值/段内判异。
 */
import { describe, it, expect } from 'vitest';
import { splitStages, stagedXbar, stagedRange, stageValidationError } from '../stages';
import { DEFAULT_RULES } from '../spc';

const RULES = DEFAULT_RULES;

describe('splitStages', () => {
  it('连续段切分与不连续同名标签', () => {
    expect(splitStages(['A', 'A', 'B', 'B', 'A'])).toEqual([
      { label: 'A', start: 0, end: 1 },
      { label: 'B', start: 2, end: 3 },
      { label: 'A', start: 4, end: 4 },
    ]);
  });

  it('拒绝单点阶段，避免用退化控制限洗掉异常', () => {
    const labels = ['基线', '基线', '异常点', '改善后', '改善后'];
    expect(stageValidationError(labels)).toContain('只有 1 个点');
    expect(() => stagedXbar([[1, 2], [1, 2], [100, 101], [1, 2], [1, 2]], labels, RULES))
      .toThrow(/只有 1 个点/);
  });

  it('拒绝行数不一致、空标签和只有一个连续段', () => {
    expect(stageValidationError(['A', 'A'], 3)).toContain('2 行');
    expect(stageValidationError(['A', '', 'B', 'B'])).toContain('为空');
    expect(stageValidationError(['A', 'A'])).toContain('只有 1 个连续段');
  });
});

describe('stagedXbar', () => {
  // 两段:前段均值 10,后段均值 20（n=2 子组）
  const rows = [
    [9.9, 10.1], [10.0, 10.2], [9.8, 10.0], [10.1, 10.1],
    [19.9, 20.1], [20.0, 20.2], [19.8, 20.0], [20.1, 20.1],
  ];
  const labels = ['改进前', '改进前', '改进前', '改进前', '改进后', '改进后', '改进后', '改进后'];
  const r = stagedXbar(rows, labels, RULES, 'classic');

  it('两段独立中心线(≈10 与 ≈20)', () => {
    expect(r.segments.length).toBe(2);
    expect(r.segments[0].cl).toBeCloseTo(10.025, 3);
    expect(r.segments[1].cl).toBeCloseTo(20.025, 3);
    expect(r.boundaries).toEqual([4]);
  });
  it('限值序列与段对齐,并对拍 Minitab 表值派生常数 A2(2)=3/(d2√2)', () => {
    const seg0Rbar = (0.2 + 0.2 + 0.2 + 0.0) / 4;
    expect(r.uclSeries[0]).toBeCloseTo(10.025 + (3 / (1.128 * Math.SQRT2)) * seg0Rbar, 9);
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
  it('分阶段判异使用用户自定义 K，不能静默回到默认 Nelson 参数', () => {
    const trendRows = [
      [1, 1], [2, 2], [3, 3], [4, 4],
      [11, 11], [12, 12], [13, 13], [14, 14],
    ];
    const trendLabels = ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B'];
    const trendOnly = {
      r1: false, r2: false, r3: true, r4: false,
      r5: false, r6: false, r7: false, r8: false,
    };
    expect(stagedXbar(trendRows, trendLabels, trendOnly).list.some((item) => item.rule === 3)).toBe(false);
    const custom = stagedXbar(trendRows, trendLabels, trendOnly, 'classic', { k3: 3 });
    expect(custom.list.some((item) => item.rule === 3 && item.desc.includes('连续 3 点'))).toBe(true);
  });
  it('零极差阶段使用精确零宽控制限，不用固定 epsilon 吞掉小量纲越界', () => {
    const tinyRows = [[0, 0], [1e-13, 1e-13], [0, 0], [1e-13, 1e-13]];
    const tinyLabels = ['A', 'A', 'B', 'B'];
    const rule1Only = {
      r1: true, r2: false, r3: false, r4: false,
      r5: false, r6: false, r7: false, r8: false,
    };
    const tiny = stagedXbar(tinyRows, tinyLabels, rule1Only);
    expect(tiny.segments.every((segment) => segment.sigma === 0)).toBe(true);
    expect(tiny.segments.every((segment) => segment.ucl === segment.lcl)).toBe(true);
    expect([...tiny.viol].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});

describe('stagedRange', () => {
  it('R 图段内 UCL 对拍 Minitab 表值派生常数 D4(2)=1+3d3/d2', () => {
    const rows = [
      [1, 2], [1, 2], [1, 2],
      [5, 9], [5, 9], [5, 9],
    ];
    const labels = ['a', 'a', 'a', 'b', 'b', 'b'];
    const r = stagedRange(rows, labels, RULES, 'classic');
    const d4 = 1 + (3 * 0.8525) / 1.128;
    expect(r.segments[0].cl).toBeCloseTo(1, 10);
    expect(r.segments[0].ucl).toBeCloseTo(d4, 9);
    expect(r.segments[1].cl).toBeCloseTo(4, 10);
    expect(r.segments[1].ucl).toBeCloseTo(4 * d4, 9);
  });
});
