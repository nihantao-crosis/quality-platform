/** 助手结论卡纯 builder:红绿灯与体检项。 */
import { describe, it, expect } from 'vitest';
import { spcReport, capabilityReport, gageReport, anovaReport, tReport, regReport, paretoReport } from '../reportData';

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
    expect(r.headline).toContain('2 个失控点');
    expect(r.checks[0].note).toContain('准则1×2');
    expect(r.checks[0].note).toContain('准则2×1');
    expect(r.checks[0].note).toContain('3 个点-准则命中');
  });
  it('同一子组在 X̄/R 两图命中仍计 1 个实际失控点', () => {
    const r = spcReport({
      violList: [
        { i: 7, rule: 1, desc: '', chartLabel: 'X̄' },
        { i: 7, rule: 1, desc: '', chartLabel: 'R' },
      ],
      k: 25, n: 5, hasSubgroups: true, typeLabel: 'X̄-R',
    });
    expect(r.headline).toContain('1 个失控点');
    expect(r.checks[0].note).toContain('2 个点-准则命中');
  });
  it('点数不足 → 需注意', () => {
    const r = spcReport({ violList: [], k: 12, n: 5, hasSubgroups: true, typeLabel: 'X̄-R' });
    expect(r.verdict).toBe('warn');
  });
  it('单值数据提示灵敏度', () => {
    const r = spcReport({ violList: [], k: 30, n: 1, hasSubgroups: false, typeLabel: 'I-MR' });
    expect(r.checks.find((c) => c.name === '子组结构')!.level).toBe('warn');
  });
  it('P/C 属性图不借用变量工作表的子组结构', () => {
    const p = spcReport({
      violList: [], k: 25, n: 50, hasSubgroups: false, structure: 'attribute-p', typeLabel: 'P 图',
    });
    expect(p.checks.find((c) => c.name === '抽样结构')?.note).toContain('n=50');
    expect(p.checks.some((c) => c.note.includes('组内变异'))).toBe(false);

    const c = spcReport({
      violList: [], k: 25, n: 1, hasSubgroups: false, structure: 'attribute-c', typeLabel: 'C 图',
    });
    expect(c.checks.find((x) => x.name === '计数结构')?.note).toContain('检验机会');
    expect(c.checks.some((x) => x.note.includes('单值数据'))).toBe(false);
  });
  it('X̄-R 明确先判 R；R 失控时暂停解释 X̄，并输出结构化角色信息', () => {
    const r = spcReport({
      violList: [
        { i: 4, rule: 2, desc: '趋势', chartLabel: 'X̄' },
        { i: 7, rule: 1, desc: '越界', chartLabel: 'R' },
      ],
      variationViolations: [{ i: 7, rule: 1, desc: '越界', chartLabel: 'R' }],
      variationChartLabel: 'R', k: 25, n: 5, hasSubgroups: true, typeLabel: 'X̄-R',
      variableName: '直径', dataRole: '子组列只作标签；5 个测量列',
    });
    expect(r.headline).toContain('R 图先检出');
    expect(r.headline).toContain('暂停解释');
    expect(r.checks[0].name).toBe('先判 R 图');
    expect(r.details.readingOrder).toBe('先判 R 图，再解释 X̄ 图');
    expect(r.details.variableName).toBe('直径');
    expect(r.details.dataRole).toContain('只作标签');
    expect(r.details.variationStable).toBe(false);
  });
});

describe('帕累托专项报告', () => {
  it('按频数降序、计算累计百分比并保留柱值所需结构', () => {
    const r = paretoReport({
      rows: [{ name: 'A', count: 35 }, { name: 'B', count: 15 }, { name: 'C', count: 50 }],
      mergeOther: false, threshold: 0.95,
    });
    expect(r.total).toBe(100);
    expect(r.rows.map((x) => x.name)).toEqual(['C', 'A', 'B']);
    expect(r.rows.map((x) => x.count)).toEqual([50, 35, 15]);
    expect(r.rows.map((x) => x.cumulativePercentage)).toEqual([50, 85, 100]);
  });

  it('95% 阈值将超过阈值后的多个尾部类别合并为其他', () => {
    const r = paretoReport({
      rows: [70, 20, 5, 2, 2, 1].map((count, i) => ({ name: String.fromCharCode(65 + i), count })),
      mergeOther: true, threshold: 0.95,
    });
    expect(r.rows.map((x) => x.name)).toEqual(['A', 'B', 'C', '其他']);
    expect(r.rows[r.rows.length - 1]).toMatchObject({ count: 5, mergedOther: true, cumulativePercentage: 100 });
    expect(r.mergedCategoryCount).toBe(3);
  });

  it('源数据已有“其他”时，尾部合并后只保留一个“其他”', () => {
    const r = paretoReport({
      rows: [
        { name: 'A', count: 50 }, { name: 'B', count: 20 }, { name: '其他', count: 15 },
        { name: 'C', count: 8 }, { name: 'D', count: 5 }, { name: 'E', count: 2 },
      ],
      mergeOther: true, threshold: 0.8,
    });
    expect(r.rows.map((row) => row.name)).toEqual(['A', 'B', '其他']);
    expect(r.rows.find((row) => row.name === '其他')).toMatchObject({ count: 30, mergedOther: true });
    expect(r.rows.filter((row) => row.name === '其他')).toHaveLength(1);
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

describe('Gage 结论(双判定标准,v1.40)', () => {
  const assessment = (standard: 'factory' | 'aiag', grade: 'good' | 'warn' | 'bad', label: string, detail = '判定细节'): import('../../core').GageAssessment => ({
    standard, grade, label, detail, judgedOnTolerance: true,
  });
  it('工厂口径 GRR 9%/公差内 → 理想', () => {
    const r = gageReport({ primary: assessment('factory', 'good', '理想'), reference: assessment('aiag', 'good', '可接受'), ndc: 13, grr: 9.0 });
    expect(r.verdict).toBe('ok');
    expect(r.headline).toContain('理想');
    expect(r.headline).toContain('工厂标准');
    expect(r.checks.find((c) => c.name.includes('ndc'))!.level).toBe('ok');
    expect(r.checks.find((c) => c.name.includes('对照'))!.note).toContain('可接受');
  });
  it('AIAG 口径 GRR 35% → 不可接受;ndc<5 提示受限', () => {
    const r = gageReport({ primary: assessment('aiag', 'bad', '不可接受'), reference: assessment('factory', 'bad', '不可接受'), ndc: 1, grr: 35 });
    expect(r.verdict).toBe('bad');
    expect(r.headline).toContain('先改进测量');
    const ndcCheck = r.checks.find((c) => c.name.includes('ndc'))!;
    expect(ndcCheck.level).toBe('warn');
    expect(ndcCheck.note).toContain('ndc=1');
  });
  it('工厂口径 GRR 10.51% → 可接受(warn 级),对照 AIAG 临界', () => {
    const r = gageReport({ primary: assessment('factory', 'warn', '可接受'), reference: assessment('aiag', 'warn', '临界'), ndc: 13, grr: 10.51 });
    expect(r.verdict).toBe('warn');
    expect(r.headline).toContain('可接受');
    expect(r.checks.find((c) => c.name.includes('对照'))!.note).toContain('临界');
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
