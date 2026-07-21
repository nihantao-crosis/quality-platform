/** 批次J(P0-4/P1-7):能力唯一判定器 + 页面报告卡与判定器口径一致。 */
import { describe, it, expect } from 'vitest';
import { assessCapability, assessSpcCharts, countCapabilityViolations } from '../capabilityAssessment';
import { computeVarModel } from '../model';
import { DEFAULT_RULE_K, DEFAULT_RULES, evalLimitedRules, type NelsonRules } from '../spc';
import { capabilityReport } from '../../ui/reportData';

describe('assessCapability 唯一判定器(P0-4)', () => {
  it('受控 + 能力充足 → ok/「能力充足」,可给绿色', () => {
    const a = assessCapability({ cpk: 1.5, verdict: 'sufficient', adP: 0.4, n: 125, spcViolations: 0 });
    expect(a.level).toBe('ok');
    expect(a.status).toBe('能力充足');
    expect(a.headline).toContain('能力充足');
  });

  it('失控时即使 Cpk 极高也不得为 ok,状态必须点明「过程不稳定」', () => {
    const a = assessCapability({ cpk: 37.99, verdict: 'sufficient', adP: 0.4, n: 100, spcViolations: 19 });
    expect(a.level).not.toBe('ok');
    expect(a.status).toContain('过程不稳定');
    expect(a.status).not.toBe('能力充足');
    expect(a.headline).toContain('19 个失控点');
    expect(a.headline).toContain('不得用于预测未来');
  });

  it('能力不足(受控)→ bad;偏离正态(受控)→ 至少 warn', () => {
    expect(assessCapability({ cpk: 0.8, verdict: 'insufficient', adP: 0.4, n: 100, spcViolations: 0 }).level).toBe('bad');
    const norm = assessCapability({ cpk: 1.5, verdict: 'sufficient', adP: 0.01, n: 100, spcViolations: 0 });
    expect(norm.level).toBe('warn');
  });

  it('countCapabilityViolations:含 3σ 外子组的模型必检出失控;平稳模型为 0', () => {
    const stableRows = Array.from({ length: 30 }, (_, i) => Array.from({ length: 5 }, (_, j) => 25 + Math.sin(i * 5 + j) * 0.01));
    const stable = computeVarModel('稳', ['a', 'b', 'c', 'd', 'e'], stableRows);
    expect(countCapabilityViolations(stable, DEFAULT_RULES, DEFAULT_RULE_K)).toBe(0);
    const shifted = stableRows.map((r, i) => (i === 15 ? r.map((v) => v + 1) : [...r]));
    const unstable = computeVarModel('漂', ['a', 'b', 'c', 'd', 'e'], shifted);
    expect(countCapabilityViolations(unstable, DEFAULT_RULES, DEFAULT_RULE_K)).toBeGreaterThan(0);
  });

  it('页面报告卡(capabilityReport)的 verdict/headline 与判定器逐字一致(防口径分叉回归)', () => {
    for (const args of [
      { cpk: 37.99, verdict: 'sufficient' as const, adP: 0.4, n: 100, spcViolations: 19 },
      { cpk: 1.5, verdict: 'sufficient' as const, adP: 0.4, n: 125, spcViolations: 0 },
      { cpk: 1.1, verdict: 'marginal' as const, adP: null, n: 20, spcViolations: 0 },
      { cpk: 0.7, verdict: 'insufficient' as const, adP: 0.01, n: 50, spcViolations: 3 },
    ]) {
      const a = assessCapability(args);
      const r = capabilityReport(args);
      expect(r.verdict).toBe(a.level);
      expect(r.headline).toBe(a.headline);
    }
  });

  it('P1-7:正态性通过时的文案为「未拒绝正态假设」,不再称「正态假设成立」', () => {
    const r = capabilityReport({ cpk: 1.5, verdict: 'sufficient', adP: 0.4, n: 125, spcViolations: 0 });
    const normNote = r.checks.find((c) => c.name === '正态性')!.note;
    expect(normNote).toContain('未拒绝正态假设');
    expect(normNote).not.toContain('正态假设成立');
  });
});

describe('assessSpcCharts 结构化点明细', () => {
  const OFF: NelsonRules = {
    r1: false, r2: false, r3: false, r4: false,
    r5: false, r6: false, r7: false, r8: false,
  };

  it('漏传 ruleK 立即失败，不静默回落标准值', () => {
    const M = computeVarModel('漏传K.csv', ['x'], [[1], [2], [1], [2]]);
    expect(() => assessSpcCharts(M, OFF, undefined as never)).toThrow('必须显式传入 ruleK');
  });

  it('K2=12 的连续 24 点输出 24 条点×准则明细，不退化为窗口触发终点', () => {
    // 前 24 个子组均值在中心线上方，最后一个极低值把总中心线拉到 0；只启用准则 2。
    const rows = [...Array.from({ length: 24 }, () => [1, 1]), [-24, -24]];
    const M = computeVarModel('K2-12.csv', ['a', 'b'], rows);
    const assessment = assessSpcCharts(
      M,
      { ...OFF, r2: true },
      { ...DEFAULT_RULE_K, k2: 12 },
    );

    expect(assessment.locationViolIndexes.size).toBe(24);
    expect(assessment.dispersionViolIndexes.size).toBe(0);
    expect(assessment.chartPointCount).toBe(24);
    expect(assessment.analysisUnitLabel).toBe('子组');
    expect(assessment.uniqueAnalysisUnitCount).toBe(24);
    expect(assessment.events).toHaveLength(24);
    expect(assessment.events.map((event) => event.i)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(assessment.events.every((event) => event.chart === 'X̄' && event.rule === 2)).toBe(true);
  });

  it('I-MR 同一观测跨图命中：图内累计 3 点，跨图只计 2 个原始观测', () => {
    const rows: number[][] = [[10], [30], [10]];
    for (let i = 0; i < 17; i++) rows.push([i % 2 === 0 ? 10.05 : 10]);
    const M = computeVarModel('跨图重合.csv', ['x'], rows);
    const assessment = assessSpcCharts(M, { ...OFF, r1: true }, DEFAULT_RULE_K);

    expect([...assessment.locationViolIndexes]).toEqual([1]);
    // MR 图本地 0 基：MR[0]/MR[1] 分别对应原始观测索引 1/2。
    expect([...assessment.dispersionViolIndexes]).toEqual([0, 1]);
    expect(assessment.locationPoints).toBe(1);
    expect(assessment.dispersionPoints).toBe(2);
    expect(assessment.chartPointCount).toBe(3);
    expect(assessment.analysisUnitLabel).toBe('观测');
    expect(assessment.uniqueAnalysisUnitCount).toBe(2);
    expect(assessment.uniquePointCount).toBe(assessment.uniqueAnalysisUnitCount);
  });

  it('绕过 TypeScript 传入空/非法 K 时，图点与明细共用同一规范化 K', () => {
    const rows = [...Array.from({ length: 18 }, () => [1, 1]), [-18, -18]];
    const M = computeVarModel('非法K.csv', ['a', 'b'], rows);
    const rules = { ...OFF, r2: true };
    const expected = assessSpcCharts(M, rules, DEFAULT_RULE_K);
    for (const raw of [{}, { k2: Number.NaN }]) {
      const actual = assessSpcCharts(M, rules, raw as never);
      expect(actual.chartPointCount).toBe(expected.chartPointCount);
      expect(actual.events).toEqual(expected.events);
      expect(actual.events).toHaveLength(actual.chartPointCount);
    }
  });

  it('13 万点高命中离散图仍可保留完整明细，不因 spread 参数上限崩溃', () => {
    const n = 130_000;
    const result = evalLimitedRules(
      Array(n).fill(1) as number[],
      0,
      3,
      -1,
      { ...OFF, r2: true },
      { ...DEFAULT_RULE_K, k2: 2 },
    );
    expect(result.viol.size).toBe(n);
    expect(result.list).toHaveLength(n - 1);
  });

  it('20 万行看板计数走 count-only 路径并完成，不构建报告事件', () => {
    const n = 200_000;
    const M = computeVarModel(
      '20万I-MR.csv',
      ['x'],
      Array.from({ length: n }, (_, index) => [index % 2]),
    );
    const count = countCapabilityViolations(M, { ...OFF, r4: true }, DEFAULT_RULE_K);
    expect(count).toBeGreaterThan(n - DEFAULT_RULE_K.k4);
    expect(count).toBeLessThanOrEqual(n * 2);
  });

  it('count-only 与完整 assessment 在中等高命中夹具上计数完全相同', () => {
    const M = computeVarModel(
      '中等I-MR.csv',
      ['x'],
      Array.from({ length: 2_000 }, (_, index) => [index % 2 ? 2 : 0]),
    );
    const rules = { ...OFF, r2: true, r4: true };
    expect(countCapabilityViolations(M, rules, DEFAULT_RULE_K))
      .toBe(assessSpcCharts(M, rules, DEFAULT_RULE_K).chartPointCount);
  });
});
