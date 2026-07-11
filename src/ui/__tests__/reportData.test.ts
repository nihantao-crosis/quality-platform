/** 助手结论卡纯 builder:红绿灯与体检项。 */
import { describe, it, expect } from 'vitest';
import { spcReport, capabilityReport, gageReport, anovaReport, tReport, regReport } from '../reportData';

describe('SPC 结论', () => {
  it('无失控 + 数据充足 → 通过', () => {
    const r = spcReport({ violList: [], k: 25, n: 5, hasSubgroups: true, typeLabel: 'X̄-R' });
    expect(r.verdict).toBe('ok');
    expect(r.headline).toContain('受控');
    expect(r.checks.every((c) => c.level === 'ok')).toBe(true);
  });
  it('有失控点 → 需处理,按准则汇总', () => {
    const r = spcReport({
      violList: [{ i: 3, rule: 1, desc: '' }, { i: 9, rule: 1, desc: '' }, { i: 9, rule: 2, desc: '' }],
      k: 25, n: 5, hasSubgroups: true, typeLabel: 'X̄-R',
    });
    expect(r.verdict).toBe('bad');
    expect(r.headline).toContain('2 个失控信号'); // 去重后 2 个点
    expect(r.checks[0].note).toContain('准则1×2');
    expect(r.checks[0].note).toContain('准则2×1');
  });
  it('点数不足 → 需注意', () => {
    const r = spcReport({ violList: [], k: 12, n: 5, hasSubgroups: true, typeLabel: 'X̄-R' });
    expect(r.verdict).toBe('warn');
  });
  it('单值数据提示灵敏度', () => {
    const r = spcReport({ violList: [], k: 30, n: 1, hasSubgroups: false, typeLabel: 'I-MR' });
    expect(r.checks.find((c) => c.name === '子组结构')!.level).toBe('warn');
  });
});

describe('能力结论', () => {
  it('演示口径:Cpk 1.36 + 正态 + 125 观测 → 通过', () => {
    const r = capabilityReport({ cpk: 1.36, verdict: 'sufficient', adP: 0.113, n: 125, spcViolations: 0 });
    expect(r.verdict).toBe('ok');
    expect(r.headline).toContain('充足');
  });
  it('非正态把整体降为需注意并建议 Box-Cox', () => {
    const r = capabilityReport({ cpk: 1.5, verdict: 'sufficient', adP: 0.01, n: 200, spcViolations: 0 });
    expect(r.verdict).toBe('warn');
    expect(r.checks.find((c) => c.name === '正态性')!.note).toContain('Box-Cox');
  });
  it('能力不足 → 需处理', () => {
    const r = capabilityReport({ cpk: 0.8, verdict: 'insufficient', adP: 0.5, n: 120, spcViolations: 0 });
    expect(r.verdict).toBe('bad');
  });
  it('过程不稳时提示能力无预测意义', () => {
    const r = capabilityReport({ cpk: 1.4, verdict: 'sufficient', adP: 0.5, n: 120, spcViolations: 3 });
    expect(r.checks.find((c) => c.name === '过程稳定性')!.level).toBe('warn');
  });
});

describe('Gage 结论', () => {
  it('GRR 9% → 可接受', () => {
    const r = gageReport({ grr: 9.0, verdict: 'acceptable' });
    expect(r.verdict).toBe('ok');
    expect(r.headline).toContain('可接受');
  });
  it('GRR 35% → 不可接受', () => {
    const r = gageReport({ grr: 35, verdict: 'unacceptable' });
    expect(r.verdict).toBe('bad');
    expect(r.headline).toContain('先改进测量');
  });
});

describe('假设检验结论', () => {
  it('ANOVA 显著 headline 给行动建议', () => {
    const r = anovaReport({ p: 0.012, significant: true, groups: [{ name: 'A', n: 40 }, { name: 'B', n: 40 }, { name: 'C', n: 45 }] });
    expect(r.verdict).toBe('ok');
    expect(r.headline).toContain('显著');
    expect(r.headline).toContain('最高与最低');
  });
  it('小组样本量 → 需注意', () => {
    const r = anovaReport({ p: 0.3, significant: false, groups: [{ name: 'A', n: 3 }, { name: 'B', n: 8 }] });
    expect(r.verdict).toBe('warn');
  });
  it('t 检验小样本提示正态依赖', () => {
    const r = tReport({ kind: 't1', p: 0.2, significant: false, n: 12 });
    expect(r.checks.find((c) => c.name === '样本量')!.level).toBe('warn');
  });
  it('回归:显著 + 高 R² → 通过并可预测', () => {
    const r = regReport({ r2: 0.85, p: 0.001, significant: true, n: 50 });
    expect(r.verdict).toBe('ok');
    expect(r.headline).toContain('可用于预测');
  });
  it('回归:R² 弱 → 不宜预测', () => {
    const r = regReport({ r2: 0.15, p: 0.04, significant: true, n: 50 });
    expect(r.checks.find((c) => c.name === '拟合度')!.level).toBe('bad');
  });
});
