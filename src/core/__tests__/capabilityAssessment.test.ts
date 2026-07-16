/** 批次J(P0-4/P1-7):能力唯一判定器 + 页面报告卡与判定器口径一致。 */
import { describe, it, expect } from 'vitest';
import { assessCapability, countCapabilityViolations } from '../capabilityAssessment';
import { computeVarModel } from '../model';
import { DEFAULT_RULES } from '../spc';
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
    expect(countCapabilityViolations(stable, DEFAULT_RULES)).toBe(0);
    const shifted = stableRows.map((r, i) => (i === 15 ? r.map((v) => v + 1) : [...r]));
    const unstable = computeVarModel('漂', ['a', 'b', 'c', 'd', 'e'], shifted);
    expect(countCapabilityViolations(unstable, DEFAULT_RULES)).toBeGreaterThan(0);
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
