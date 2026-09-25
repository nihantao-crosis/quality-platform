/**
 * 2026-09 全面审查第 3 批复审 · fix2609k G20-spcguard(core 层)
 * - CORE-08 残余:零变异常数数据(53×0.1、25 组×3×0.09、13×0.03)均值 1 ulp 漂移 → Shewhart
 *   控制限塌缩、全部点判失控;通用 σ̂ 守卫统一「不可判定」;近零 σ̂(19×0.1 + 1 个 0.1+1ulp)同样拦截。
 * - UI-03:niceTicks 亚 ulp 跨度不前进 → 一直 push 到 RangeError。
 * - CORE-09/UI-12 残余:capabilityStabilityCaliber 取 SPC 页实际生效的视图与阶段。
 * 全部调用真实生产函数;非零变异数据逐位不变由 goldenBenchmarks/swarmIncrementalModel/spc720 与本文件对拍用例共同证明。
 */
import { describe, expect, it } from 'vitest';
import {
  advancedSpcSigmaIssue, assessSpcCharts, capabilityStabilityCaliber, computeVarModel, countCapabilityViolations,
  cusumSeries, DEFAULT_RULE_K, evaluateSpcChartRules, ewmaSeries, mean, shewhartSigmaIssue, spcChartFamilyFor,
  spcSigmaIssue, spcStabilityViewFromRoles, updateVarModelCell,
} from '..';
import { niceTicks } from '../../ui/tokens';

const ALL_RULES = { r1: true, r2: true, r3: true, r4: true, r5: true, r6: true, r7: true, r8: true };
const RULE1 = { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };

const single = (value: number, count: number) => computeVarModel('常数单值.csv', ['x'], Array.from({ length: count }, () => [value]));
const grouped = (value: number, k: number, n: number) => computeVarModel(
  '常数子组.csv', Array.from({ length: n }, (_, j) => `m${j + 1}`), Array.from({ length: k }, () => Array.from({ length: n }, () => value)),
);

/** 修复前的 niceTicks 算法(仅加迭代上限以免测试本身卡死),用于证明常规量程逐位不变。 */
function legacyNiceTicks(lo: number, hi: number, target = 5): number[] {
  if (!(hi > lo)) return [lo];
  const step0 = (hi - lo) / Math.max(1, target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const start = Math.ceil(lo / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-9 && out.length < 5000; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

describe('UI-03 niceTicks 亚 ulp 跨度', () => {
  it('3 个 0.1 的均值(0.1+1ulp)作纵轴上限:立即返回端点，不再 push 到 RangeError', () => {
    const drifted = mean([0.1, 0.1, 0.1]);
    expect(drifted).toBe(0.10000000000000002);
    const t0 = performance.now();
    const ticks = niceTicks(0.1, drifted, 5);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(ticks).toEqual([0.1, drifted]);
    // 其他退化跨度:大量级 + 数个 ulp、start+step 加不动
    expect(niceTicks(1e6, 1e6 + 2 ** -30, 5).length).toBeLessThanOrEqual(1000);
    expect(niceTicks(123456.7, 123456.70000000003, 5)).toEqual([123456.7, 123456.70000000003]);
  });

  it('常规量程与修复前算法逐位一致(对拍 2000 组随机量程)', () => {
    let seed = 20260926;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 2000; i++) {
      const scale = 10 ** Math.floor(rand() * 16 - 8);
      const lo = (rand() - 0.5) * 100 * scale;
      const hi = lo + (0.001 + rand() * 50) * scale;
      const target = 3 + Math.floor(rand() * 6);
      expect(niceTicks(lo, hi, target)).toEqual(legacyNiceTicks(lo, hi, target));
    }
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(0, 10, 5)).toEqual(legacyNiceTicks(0, 10, 5));
  });
});

describe('CORE-08 零变异数据的均值 1 ulp 漂移', () => {
  it('53×0.1 单值:中心线/UCL/LCL 等于读数本身(修复前 indMean=0.1+1ulp,控制限塌缩在读数之上)', () => {
    const M = single(0.1, 53);
    expect(M.indMean).toBe(0.1);
    expect(M.oMean).toBe(0.1);
    expect(M.xbarbar).toBe(0.1);
    expect(M.iUcl).toBe(0.1);
    expect(M.iLcl).toBe(0.1);
  });

  it('25 组×3×0.09 子组 / 13×0.03 单值:X̿、子组均值与总均值都等于读数', () => {
    const G = grouped(0.09, 25, 3);
    expect(G.xbarbar).toBe(0.09);
    expect(G.subs.every((sub) => sub.mean === 0.09)).toBe(true);
    expect(G.oMean).toBe(0.09);
    expect(G.uclX).toBe(0.09);
    expect(single(0.03, 13).indMean).toBe(0.03);
  });

  it('非零变异数据逐位不变:含常数子组的有变异数据仍按原 mean 计算(不做子组级特判)', () => {
    const rows = [[0.1, 0.1, 0.1], [0.2, 0.25, 0.3], [0.1, 0.1, 0.1], [0.15, 0.2, 0.1]];
    const M = computeVarModel('混合.csv', ['a', 'b', 'c'], rows);
    rows.forEach((row, i) => expect(M.subs[i].mean).toBe(mean(row)));
    expect(M.xbarbar).toBe(mean(rows.map((row) => mean(row))));
    expect(M.oMean).toBe(mean(rows.flat()));
    expect(M.indMean).toBe(mean(rows.flat()));
  });

  it('增量编辑与全量重建逐位一致:进入/离开零变异状态都重建', () => {
    const constant = grouped(0.1, 6, 3);
    const leaving = updateVarModelCell(constant, 2, 1, 0.2);
    const leavingFull = computeVarModel(constant.name, constant.colNames, leaving.subs.map((sub) => sub.vals));
    expect(leaving.subs.map((sub) => sub.mean)).toEqual(leavingFull.subs.map((sub) => sub.mean));
    expect([leaving.xbarbar, leaving.oMean, leaving.indMean, leaving.uclX]).toEqual(
      [leavingFull.xbarbar, leavingFull.oMean, leavingFull.indMean, leavingFull.uclX],
    );
    const entering = updateVarModelCell(leaving, 2, 1, 0.1);
    expect(entering.xbarbar).toBe(0.1);
    expect(entering.subs.every((sub) => sub.mean === 0.1)).toBe(true);
    expect(entering.indMean).toBe(0.1);
  });
});

describe('CORE-08 通用 σ̂ 守卫(Shewhart + EWMA/CUSUM)', () => {
  it('53×0.1 I-MR / 25×3×0.09 X̄-R / 3 组×n=2×0.1 X̄-R:统一不可判定，不出失控点也不称受控', () => {
    const cases = [
      { M: single(0.1, 53), family: 'i-mr' as const },
      { M: single(0.03, 13), family: 'i-mr' as const },
      { M: grouped(0.09, 25, 3), family: 'xbar-r' as const },
      { M: grouped(0.1, 3, 2), family: 'xbar-r' as const },
      { M: grouped(0.09, 25, 3), family: 'xbar-s' as const },
    ];
    for (const { M, family } of cases) {
      expect(shewhartSigmaIssue(M, family)).toContain('σ̂=0');
      const evaluation = evaluateSpcChartRules(M, ALL_RULES, DEFAULT_RULE_K, family, false);
      expect(evaluation.unavailableReason).toContain('不可判定');
      expect(evaluation.location.viol.size + evaluation.dispersion.viol.size).toBe(0);
      const assessment = assessSpcCharts(M, ALL_RULES, DEFAULT_RULE_K, family);
      expect(assessment.unavailableReason).toContain('σ̂=0');
      expect(assessment.stable).toBe(false);
      expect(assessment.chartPointCount).toBe(0);
      expect(assessment.verdictLine).toContain('不可判定');
      expect(assessment.verdictLine).not.toContain('受控');
    }
  });

  it('近零 σ̂(19×0.1 + 1 个 0.10000000000000002):EWMA/CUSUM/I-MR 都拦截(修复前 EWMA 20/20 失控)', () => {
    const values = [...Array.from({ length: 19 }, () => 0.1), 0.10000000000000002];
    const M = computeVarModel('浮点尾差.csv', ['x'], values.map((value) => [value]));
    expect(M.iSig).toBeGreaterThan(0);
    expect(M.iSig).toBeLessThan(1e-17);
    const ewma = ewmaSeries(M.indiv, M.indMean, M.iSig);
    expect(ewma.unavailableReason).toContain('σ̂ 小于数值分辨率');
    expect(ewma.viol.size).toBe(0);
    const cusum = cusumSeries(M.indiv, M.indMean, M.iSig, 0.5, 5);
    expect(cusum.unavailableReason).toContain('σ̂ 小于数值分辨率');
    expect(cusum.viol.size).toBe(0);
    expect(shewhartSigmaIssue(M, 'i-mr')).toContain('σ̂ 小于数值分辨率');
    expect(advancedSpcSigmaIssue(M.iSig, M.indMean)).toContain('EWMA/CUSUM 不可判定');
  });

  it('真实有变异的数据不受守卫影响(阈值只在浮点舍入量级)', () => {
    expect(spcSigmaIssue(1e-9, 1e3, 'I-MR')).toBeNull();
    expect(spcSigmaIssue(1e-300, 0, 'I-MR')).toBeNull();
    expect(advancedSpcSigmaIssue(0.01, 10)).toBeNull();
    // 省略中心线时保持旧口径:只拦非正/非有限
    expect(advancedSpcSigmaIssue(1e-30)).toBeNull();
    const M = computeVarModel('常规.csv', ['x'], [10.1, 10.3, 9.9, 10.0, 10.2, 9.8, 10.1].map((v) => [v]));
    expect(shewhartSigmaIssue(M, 'i-mr')).toBeNull();
    const assessment = assessSpcCharts(M, RULE1, DEFAULT_RULE_K, 'i-mr');
    expect(assessment.unavailableReason).toBeNull();
    expect(assessment.stable).toBe(true);
  });

  it('能力口径计数不设 σ̂ 守卫(口径不动)', () => {
    const values = [...Array.from({ length: 19 }, () => 0.1), 0.10000000000000002];
    const M = computeVarModel('浮点尾差.csv', ['x'], values.map((value) => [value]));
    const raw = evaluateSpcChartRules(M, RULE1, DEFAULT_RULE_K, 'i-mr', false, null, false);
    expect(raw.unavailableReason).toBeNull();
    expect(countCapabilityViolations(M, RULE1, DEFAULT_RULE_K, spcChartFamilyFor(M, 'xbar-r')))
      .toBe(raw.location.viol.size + raw.dispersion.viol.size);
  });
});

describe('CORE-09/UI-12 残余:能力口径披露取 SPC 页实际生效的视图与阶段', () => {
  it('阶段列无效(单段)时不再误称「与 SPC 页分阶段结论口径不同」', () => {
    const rows = Array.from({ length: 6 }, (_, i) => [10 + (i % 3) * 0.1, 10.2 + (i % 2) * 0.1]);
    const M = computeVarModel('单段.csv', ['a', 'b'], rows);
    const textCols = [{ name: '阶段', values: rows.map(() => '全部') }];
    const view = spcStabilityViewFromRoles(M, textCols, { layout: 'rows', valueColumn: null, subgroupColumn: null }, 'xbar-r', '阶段');
    expect(view.spcStage.state).toBe('invalid');
    const caliber = capabilityStabilityCaliber({ capabilityFamily: 'xbar-r', ...view });
    expect(caliber?.text).toBe('稳定性按 X̄-R 图评估；SPC 分阶段未运行，能力稳定性按全局控制限评估');
    expect(caliber?.text).not.toContain('分阶段结论口径不同');
  });

  it('SPC 单值(实际显示 I-MR)+ 能力常量子组 X̄-R + 默认 spcType=xbar-r:必须披露图型不同(修复前返回 null)', () => {
    const M = computeVarModel('单列100.csv', ['x'], Array.from({ length: 100 }, (_, i) => [10 + ((i * 37) % 11) * 0.05]));
    const view = spcStabilityViewFromRoles(M, [], { layout: 'individuals', valueColumn: 'x', subgroupColumn: null }, 'xbar-r', null);
    expect(view.spcViewType).toBe('i-mr');
    const caliber = capabilityStabilityCaliber({ capabilityFamily: 'xbar-r', ...view });
    expect(caliber?.text).toBe('稳定性按 X̄-R 图评估；与 SPC 页当前 I-MR 视图口径不同');
    // 视图一致(单值能力 + 单值 SPC)时不加噪声
    expect(capabilityStabilityCaliber({ capabilityFamily: 'i-mr', ...view })).toBeNull();
  });
});
