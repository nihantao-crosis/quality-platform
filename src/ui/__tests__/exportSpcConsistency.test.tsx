/** v1.42.3(审计 P1)回归:四种通用导出格式的 SPC 判异必须消费同一 SpcAssessment——
 * R/MR-only 失控时任何格式不得同时出现「受控」与「不稳定」;规则/K 跟随用户设置。
 * @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { computeVarModel, assessSpcCharts, DEFAULT_RULE_K, type NelsonRules } from '../../core';
import { textReport } from '../../platform/report';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildXlsx } from '../../platform/xlsxExport';
import * as XLSX from 'xlsx';

// r4(交替)必须关:R-only 夹具的均值刻意 ±0.01 交替以保持位置图干净,开 r4 会全中
const RULES: NelsonRules = { r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false };
const OFF: NelsonRules = { r1: false, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
const SPEC = { lsl: 5, tgt: 10, usl: 15 };

/** R-only 失控夹具:均值交替 ±0.01(位置图稳),5 个子组极差 8 >> R-UCL(离散图 r1 失控) */
function rOnlyModel() {
  const rows: number[][] = [];
  for (let i = 0; i < 25; i++) {
    const mu = 10 + (i % 2 === 0 ? 0.01 : -0.01);
    const spread = i % 5 === 4 ? 4 : 0.5;
    rows.push([mu - spread, mu - spread / 2, mu, mu + spread / 2, mu + spread]);
  }
  return computeVarModel('R失控.csv', ['a', 'b', 'c', 'd', 'e'], rows);
}

describe('assessSpcCharts 唯一判异源', () => {
  it('R-only 夹具:位置图 0 点、离散图 >0 点,结论行先判 R 图', () => {
    const M = rOnlyModel();
    const a = assessSpcCharts(M, RULES, DEFAULT_RULE_K);
    expect(a.locationPoints).toBe(0);
    expect(a.dispersionPoints).toBeGreaterThan(0);
    expect(a.uniquePointCount).toBe(a.dispersionPoints);
    expect(a.stable).toBe(false);
    expect(a.verdictLine).toContain('R 图检出');
    expect(a.verdictLine).toContain('暂不解释 X̄ 图');
    expect(a.events.every((e) => e.chart === 'R')).toBe(true);
  });

  it('I-MR:MR 事件点号精确映射到观测号,且与 I 图按观测去重', () => {
    // 观测 2 是尖峰:I 图 r1 命中点 2;MR[0]=|30−10|、MR[1]=|10−30| 两个大跳 → MR 图命中观测 2、3
    const values: number[][] = [[10], [30], [10]];
    for (let k = 0; k < 17; k++) values.push([k % 2 === 0 ? 10.05 : 10]);
    const M = computeVarModel('MR尖峰.csv', ['x'], values);
    const a = assessSpcCharts(M, { ...OFF, r1: true }, DEFAULT_RULE_K);
    expect(a.dispersionLabel).toBe('MR');
    // 精确点号:丢失 +1 偏移会得到 [1, 2],此断言即红
    expect(a.events.filter((e) => e.chart === 'MR').map((e) => e.i + 1)).toEqual([2, 3]);
    expect(a.events.filter((e) => e.chart === 'I').map((e) => e.i + 1)).toEqual([2]);
    // 观测 2 双图命中:逐图累计 3,按观测去重 2
    expect(a.locationPoints + a.dispersionPoints).toBe(3);
    expect(a.uniquePointCount).toBe(2);
  });

  it('规则全关 → 稳定受控;规则/K 生效(自定义 K1 收紧后检出更多)', () => {
    const M = rOnlyModel();
    expect(assessSpcCharts(M, OFF, DEFAULT_RULE_K).stable).toBe(true);
    const tight = assessSpcCharts(M, { ...OFF, r1: true }, { ...DEFAULT_RULE_K, k1: 1 });
    const normal = assessSpcCharts(M, { ...OFF, r1: true }, DEFAULT_RULE_K);
    expect(tight.uniquePointCount).toBeGreaterThanOrEqual(normal.uniquePointCount);
  });
});

describe('跨格式一致性(同一 R-only 数据)', () => {
  const M = rOnlyModel();
  const a = assessSpcCharts(M, RULES, DEFAULT_RULE_K);

  it('textReport:不再出现「未检出失控点」,三个计数各自标注口径', () => {
    const text = textReport(M, SPEC, a);
    expect(text).not.toContain('未检出失控点');
    expect(text).toContain('R 图检出');
    expect(text).toContain(`判异明细（X̄ 图 ${a.locationPoints} 点 + R 图 ${a.dispersionPoints} 点，去重后 ${a.uniquePointCount} 个失控观测）`);
  });

  it('HTML 报告:结论行与失控点表一致,无自相矛盾', () => {
    const html = buildHtmlReport(M, SPEC, a);
    expect(html).not.toContain('未检出失控点');
    expect(html).toContain('R 图检出');
    expect(html).toContain('过程不稳定');
  });

  it('Excel:统计摘要失控点数 = 失控点工作表行数(位置+离散口径)', () => {
    const wb = XLSX.read(buildXlsx(M, SPEC, a), { type: 'array' });
    const summaryRows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['统计摘要'], { header: 1 });
    const stability = summaryRows.map((r) => (r ?? []).join('|')).find((t) => t.includes('过程稳定性')) ?? '';
    expect(stability).toContain(`${a.locationPoints + a.dispersionPoints} 个失控点`);
    const violRows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['失控点'], { header: 1 });
    expect(violRows.length - 1).toBe(a.events.length);
    expect(violRows.slice(1).every((r) => r[1] === 'R')).toBe(true);
  });

  it('规则全关时三种格式一致写受控', () => {
    const calm = assessSpcCharts(M, OFF, DEFAULT_RULE_K);
    expect(textReport(M, SPEC, calm)).toContain('未检出失控点');
    expect(buildHtmlReport(M, SPEC, calm)).toContain('未检出失控点');
    const wb = XLSX.read(buildXlsx(M, SPEC, calm), { type: 'array' });
    const violRows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['失控点'], { header: 1 });
    expect(violRows[1].join('')).toContain('未检出失控点');
  });
});

describe('mean/stdev 极值守卫(审计 P2)', () => {
  it('[-1e308, 1e308] 不再 NaN/0', async () => {
    const { mean, stdev } = await import('../../core');
    expect(mean([-1e308, 1e308])).toBe(0);
    expect(stdev([-1e308, 1e308])).toBeCloseTo(Math.SQRT2 * 1e308, -294);
    expect(Number.isFinite(stdev([-1e308, 1e308]))).toBe(true);
    // 常规数据行为不变
    expect(mean([1, 2, 3])).toBe(2);
    expect(stdev([1, 2, 3])).toBeCloseTo(1, 12);
  });

  it('阈值随样本量收紧:单项差不溢出但部分和溢出的反例(对抗审查)', async () => {
    const { mean, stdev } = await import('../../core');
    // maxAbs=4e307 ≤ MAX/4,旧守卫不触发;offsetMean 部分和 3×8e307 溢出 → 旧 mean=NaN、stdev=0
    expect(mean([-4e307, 4e307, 4e307, 4e307])).toBe(2e307);
    expect(stdev([-4e307, 4e307, 4e307, 4e307])).toBe(4e307);
    // 大 n:maxAbs 离 MAX/4 差两个数量级仍会因累加溢出
    const many = [0, ...Array(2000).fill(1.8e305) as number[]];
    expect(Number.isFinite(mean(many))).toBe(true);
    expect(mean(many)).toBeCloseTo(1.8e305 * (2000 / 2001), -300);
    expect(Number.isFinite(stdev(many))).toBe(true);
  });
});
