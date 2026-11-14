/**
 * 2026-09 全面审查第 3 批 · G9-spcpipeline(核心层)
 * CORE-09 分阶段口径 / UI-12 图型口径 / PLATFORM-21 阶段解析同源 / CORE-08 EWMA·CUSUM σ̂ 守卫。
 * 全部使用真实生产函数，数据与发现记录的 reproMethod 同构。
 */
import { describe, expect, it } from 'vitest';
import {
  assessSpcCharts, capabilityStabilityCaliber, computeVarModel, countCapabilityViolations, cusumSeries,
  DEFAULT_RULE_K, evalLimitedRules, evalRules, ewmaSeries, resolveSpcStage, spcChartFamilyFor, spcViewFamilyFor,
  stagedRange, stagedXbar,
} from '..';

const RULES = { r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false };
const RULE1 = { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };

/** 改进前后台阶数据：前 10 组均值≈10.0、后 10 组≈10.5，段内平稳（CORE-09 reproObservation 同构）。 */
function stepRows(): number[][] {
  return Array.from({ length: 20 }, (_, i) => {
    const x = (i < 10 ? 10 : 10.5) + 0.02 * (((i * 7) % 5) - 2);
    const s = 0.1 + 0.02 * ((i * 3) % 4);
    return [x - 2 * s, x - s, x, x + s, x + 2 * s];
  });
}
const STAGE_LABELS = Array.from({ length: 20 }, (_, i) => (i < 10 ? '改进前' : '改进后'));

describe('CORE-08 EWMA/CUSUM σ̂=0 / 非有限守卫', () => {
  it('常数单值序列(0.1/1.7/3.3)不再因 1 ulp 递推舍入被全部判超限，显式返回不可判定', () => {
    for (const c of [0.1, 1.7, 3.3, 0.3, 5]) {
      const data = Array(20).fill(c);
      const M = computeVarModel('常数', ['x'], data.map((v) => [v]));
      expect(M.iSig).toBe(0);
      const ewma = ewmaSeries(M.indiv, M.indMean, M.iSig);
      // 修复前：c=0.1 时 z1=0.10000000000000002 > ucl=0.1，20/20 判失控
      expect(ewma.viol.size).toBe(0);
      expect(ewma.unavailableReason).toContain('σ̂=0');
      const cusum = cusumSeries(M.indiv, M.indMean, M.iSig, 0.5, 5);
      expect(cusum.viol.size).toBe(0);
      expect(cusum.unavailableReason).toContain('σ̂=0');
    }
  });

  it('子组内读数完全相同(R̄=0)、子组均值有波动时 EWMA/CUSUM 不判 7/8 失控', () => {
    const rows = [[10.1, 10.1], [10.2, 10.2], [10.1, 10.1], [10.0, 10.0], [10.1, 10.1], [10.2, 10.2], [10.0, 10.0], [10.1, 10.1]];
    const M = computeVarModel('分辨率不足', ['a', 'b'], rows);
    expect(M.sigmaChart).toBe(0);
    const sigma = M.sigmaChart / Math.sqrt(M.n);
    const means = M.subs.map((s) => s.mean);
    expect(ewmaSeries(means, M.xbarbar, sigma).viol.size).toBe(0);
    expect(cusumSeries(means, M.xbarbar, sigma, 0.5, 4).viol.size).toBe(0);
    expect(ewmaSeries(means, M.xbarbar, sigma).unavailableReason).toContain('量具分辨率');
  });

  it('非有限 σ̂ 同样不可判定；正常 σ̂ 行为不变', () => {
    expect(ewmaSeries([1, 2, 3], 2, Number.NaN).unavailableReason).toContain('不是有限');
    expect(cusumSeries([1, 2, 3], 2, Number.POSITIVE_INFINITY).unavailableReason).toContain('不是有限');
    const ok = ewmaSeries([0, 0, 0, 5, 5, 5], 0, 1);
    expect(ok.unavailableReason).toBeNull();
    expect(ok.viol.size).toBeGreaterThan(0);
    expect(cusumSeries([0, 3, 3, 3], 0, 1).unavailableReason).toBeNull();
  });
});

describe('PLATFORM-21 阶段列唯一解析入口', () => {
  const textCols = [{ name: '阶段', values: STAGE_LABELS }, { name: '班次', values: Array(20).fill('早班') }];
  it('列不存在、只有 1 段均为 invalid(与报告/保存记录同一原因文案)；非 X̄-R 或单值数据为 off', () => {
    const base = { textCols, spcType: 'xbar-r', hasSubgroups: true, pointCount: 20 };
    expect(resolveSpcStage({ ...base, stageColumn: null })).toEqual({ state: 'off' });
    expect(resolveSpcStage({ ...base, stageColumn: '不存在的列' })).toEqual({ state: 'invalid', column: '不存在的列', reason: '找不到阶段列“不存在的列”' });
    expect(resolveSpcStage({ ...base, stageColumn: '班次' })).toMatchObject({ state: 'invalid', reason: '阶段列只有 1 个连续段' });
    expect(resolveSpcStage({ ...base, stageColumn: '阶段' })).toMatchObject({ state: 'active', labels: STAGE_LABELS });
    expect(resolveSpcStage({ ...base, stageColumn: '阶段', spcType: 'xbar-s' })).toEqual({ state: 'off' });
    expect(resolveSpcStage({ ...base, stageColumn: '阶段', hasSubgroups: false })).toEqual({ state: 'off' });
  });
});

describe('CORE-09 唯一评估器支持阶段口径', () => {
  const M = computeVarModel('台阶', ['a', 'b', 'c', 'd', 'e'], stepRows());
  const stage = resolveSpcStage({
    stageColumn: '阶段', textCols: [{ name: '阶段', values: STAGE_LABELS }], spcType: 'xbar-r', hasSubgroups: true, pointCount: M.k,
  });

  it('assessSpcCharts 传入阶段后与 stagedXbar/stagedRange(SPC 页同源)逐点一致，并在结论行写明分阶段', () => {
    const rows = M.subs.map((s) => s.vals);
    const x = stagedXbar(rows, STAGE_LABELS, RULES, M.sigmaMethod, DEFAULT_RULE_K);
    const r = stagedRange(rows, STAGE_LABELS, RULES, M.sigmaMethod, DEFAULT_RULE_K);
    const staged = assessSpcCharts(M, RULES, DEFAULT_RULE_K, 'xbar-r', stage);
    expect([...staged.locationViolIndexes]).toEqual([...x.viol]);
    expect([...staged.dispersionViolIndexes]).toEqual([...r.viol]);
    expect(staged.stable).toBe(true);
    expect(staged.stage).toEqual({ column: '阶段', segmentCount: 2, segmentLabels: ['改进前', '改进后'] });
    expect(staged.verdictLine).toContain('分阶段：按「阶段」2 段段内控制限判异');
    expect(staged.location.uclSeries).toEqual(x.uclSeries);
    expect(staged.location.stageBoundaries).toEqual([10]);
    // 修复前：通用评估器无阶段入参，只能给出「✗ X̄ 图检出 20 个失控点」
    const global = assessSpcCharts(M, RULES, DEFAULT_RULE_K, 'xbar-r');
    expect(global.locationPoints).toBe(20);
    expect(global.stage ?? null).toBeNull();
  });

  it('阶段校验失败时评估器拒绝(不静默回退全局限值)', () => {
    expect(() => assessSpcCharts(M, RULES, DEFAULT_RULE_K, 'xbar-r', { state: 'invalid', column: '班次', reason: '阶段列只有 1 个连续段' }))
      .toThrow('分阶段未运行：阶段列只有 1 个连续段');
  });

  it('能力口径有意保持全局(Minitab 能力分析不分阶段)，由 capabilityStabilityCaliber 明示', () => {
    expect(countCapabilityViolations(M, RULES, DEFAULT_RULE_K, spcChartFamilyFor(M, 'xbar-r'))).toBe(20);
    const caliber = capabilityStabilityCaliber({ capabilityFamily: 'xbar-r', spcViewType: 'xbar-r', spcStage: { state: 'active', column: '阶段', labels: [] } });
    expect(caliber?.text).toContain('稳定性按 X̄-R 图、全局控制限（未分阶段）评估');
    expect(caliber?.text).toContain('能力分析不分阶段');
    expect(caliber?.short).toContain('全局限（未分阶段）');
    expect(capabilityStabilityCaliber({ capabilityFamily: 'xbar-r', spcViewType: 'xbar-r', spcStage: { state: 'off' } })).toBeNull();
    expect(capabilityStabilityCaliber({ capabilityFamily: 'i-mr', spcViewType: 'i-mr', spcStage: { state: 'off' } })).toBeNull();
  });
});

describe('UI-12 子组数据选 I-MR 的图型口径', () => {
  // 每组 9 个 10 + 1 个 13：X̄/R 全部相同(X̄-R 0 失控)，逐点 I-MR 大量超限
  const rows = Array.from({ length: 20 }, () => [10, 10, 10, 10, 10, 10, 10, 10, 10, 13]);
  const M = computeVarModel('子组', rows[0].map((_, j) => `m${j + 1}`), rows);

  it('SPC 视图图族跟随 SPC 页：子组 + I-MR 按全部单值评估，与页面逐点表达式一致', () => {
    expect(spcViewFamilyFor(M, 'i-mr')).toBe('i-mr');
    expect(spcChartFamilyFor(M, 'i-mr')).toBe('xbar-r');
    const view = assessSpcCharts(M, RULE1, DEFAULT_RULE_K, spcViewFamilyFor(M, 'i-mr'));
    const iEval = evalRules(M.indiv, M.indMean, (M.iUcl - M.indMean) / 3, RULE1, DEFAULT_RULE_K);
    const mrEval = evalLimitedRules(M.mr.slice(1) as number[], M.mrbar, M.mrUcl, 0, RULE1, DEFAULT_RULE_K);
    expect(view.locationPoints).toBe(iEval.viol.size);
    expect(view.dispersionPoints).toBe(mrEval.viol.size);
    expect(view.analysisUnitLabel).toBe('观测');
    expect(view.locationPoints).toBeGreaterThan(0);
    // 能力口径仍按 X̄-R(0 失控)——与 SPC 页结论相反，必须经文案披露
    expect(countCapabilityViolations(M, RULE1, DEFAULT_RULE_K, spcChartFamilyFor(M, 'i-mr'))).toBe(0);
    expect(() => countCapabilityViolations(M, RULE1, DEFAULT_RULE_K, 'i-mr')).toThrow('能力稳定性不得按 I-MR');
    const caliber = capabilityStabilityCaliber({ capabilityFamily: 'xbar-r', spcViewType: 'i-mr', spcStage: { state: 'off' } });
    expect(caliber?.text).toBe('稳定性按 X̄-R 图评估；与 SPC 页当前 I-MR 视图口径不同');
  });
});
