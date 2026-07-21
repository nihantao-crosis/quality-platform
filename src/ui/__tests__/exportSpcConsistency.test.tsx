/** v1.42.3(审计 P1)回归:四种通用导出格式的 SPC 判异必须消费同一 SpcAssessment——
 * R/MR-only 失控时任何格式不得同时出现「受控」与「不稳定」;规则/K 跟随用户设置。
 * @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { computeVarModel, assessSpcCharts, DEFAULT_RULE_K, type NelsonRules, type SpcAssessment } from '../../core';
import { MAX_XLSX_VIOLATION_ROWS, MAX_HTML_VIOLATION_ROWS } from '../../platform/reportLabels';
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

/** 只启用 K2=12：前 24 个子组位于中心线同侧，应展开为 24 个图表点明细。 */
function k12Model() {
  return computeVarModel(
    'K2-12.csv',
    ['a', 'b'],
    [...Array.from({ length: 24 }, () => [1, 1]), [-24, -24]],
  );
}

describe('assessSpcCharts 唯一判异源', () => {
  it('R-only 夹具:位置图 0 点、离散图 >0 点,结论行先判 R 图', () => {
    const M = rOnlyModel();
    const a = assessSpcCharts(M, RULES, DEFAULT_RULE_K);
    expect(a.locationPoints).toBe(0);
    expect(a.dispersionPoints).toBeGreaterThan(0);
    expect(a.analysisUnitLabel).toBe('子组');
    expect(a.uniqueAnalysisUnitCount).toBe(a.dispersionPoints);
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
    expect(a.analysisUnitLabel).toBe('观测');
    expect(a.uniqueAnalysisUnitCount).toBe(2);
  });

  it('规则全关 → 稳定受控;规则/K 生效(自定义 K1 收紧后检出更多)', () => {
    const M = rOnlyModel();
    expect(assessSpcCharts(M, OFF, DEFAULT_RULE_K).stable).toBe(true);
    const tight = assessSpcCharts(M, { ...OFF, r1: true }, { ...DEFAULT_RULE_K, k1: 1 });
    const normal = assessSpcCharts(M, { ...OFF, r1: true }, DEFAULT_RULE_K);
    expect(tight.uniqueAnalysisUnitCount).toBeGreaterThanOrEqual(normal.uniqueAnalysisUnitCount);
  });
});

describe('跨格式一致性(同一 R-only 数据)', () => {
  const M = rOnlyModel();
  const a = assessSpcCharts(M, RULES, DEFAULT_RULE_K);

  it('textReport:不再出现「未检出失控点」,三个计数各自标注口径', () => {
    const text = textReport(M, SPEC, a);
    expect(text).not.toContain('未检出失控点');
    expect(text).toContain('R 图检出');
    expect(text).toContain(`判异明细（各图累计 ${a.chartPointCount} 个失控点：X̄ 图 ${a.locationPoints} 个 + R 图 ${a.dispersionPoints} 个；去重子组 ${a.uniqueAnalysisUnitCount} 个）`);
  });

  it('HTML 报告:同时渲染位置图和离散图，R-only 红点确实画在 R 图', () => {
    const html = buildHtmlReport(M, SPEC, a);
    expect(html).not.toContain('未检出失控点');
    expect(html).toContain('R 图检出');
    expect(html).toContain('过程不稳定');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const headings = [...doc.querySelectorAll('h3')];
    expect(headings.map((node) => node.textContent)).toEqual(expect.arrayContaining([
      'X̄ 控制图（位置）',
      'R 控制图（离散）',
    ]));
    const locationChart = headings.find((node) => node.textContent?.includes('位置'))?.nextElementSibling;
    const dispersionChart = headings.find((node) => node.textContent?.includes('离散'))?.nextElementSibling;
    expect(locationChart?.querySelector('svg')).not.toBeNull();
    expect(dispersionChart?.querySelector('svg')).not.toBeNull();
    expect(locationChart?.querySelectorAll('circle[fill="#d21f26"]')).toHaveLength(0);
    expect(dispersionChart?.querySelectorAll('circle[fill="#d21f26"]')).not.toHaveLength(0);
    expect(html).toContain(`各图累计 ${a.chartPointCount} 个失控点`);
    expect(html).toContain(`去重子组 ${a.uniqueAnalysisUnitCount} 个`);
  });

  it('I-MR HTML 的 MR 图横轴从原始观测 2 开始，不把第一个移动极差错标为观测 1', () => {
    const rows: number[][] = [[10], [30], [10]];
    for (let index = 0; index < 17; index++) rows.push([index % 2 === 0 ? 10.05 : 10]);
    const model = computeVarModel('I-MR.csv', ['x'], rows);
    const assessment = assessSpcCharts(model, { ...OFF, r1: true }, DEFAULT_RULE_K);
    const html = buildHtmlReport(model, { lsl: 0, tgt: 15, usl: 40 }, assessment);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const heading = [...doc.querySelectorAll('h3')].find((node) => node.textContent === 'MR 控制图（离散）');
    const chart = heading?.nextElementSibling;
    const labels = [...(chart?.querySelectorAll('svg text') ?? [])].map((node) => node.textContent);
    const tooltips = [...(chart?.querySelectorAll('svg circle title') ?? [])].map((node) => node.textContent);

    expect(labels).toContain('2');
    expect(labels).not.toContain('1');
    expect(tooltips).toContain('点 2 = 20.000');
    expect(tooltips).not.toContain('点 1 = 20.000');
    expect(html).toContain('去重观测 2 个');
    expect(html).toContain('20 个单值观测');
    expect(html).toContain('σ 组内 (MR̄/d₂(2))');
    expect(html).not.toContain('20 子组 × 1 测量');

    const text = textReport(model, { lsl: 0, tgt: 15, usl: 40 }, assessment);
    expect(text).toContain('20 个单值观测');
    expect(text).toContain('σ 组内 (MR̄/d₂(2))');
    expect(text).not.toContain('20 子组 × 1 测量');

    const workbook = XLSX.read(buildXlsx(model, { lsl: 0, tgt: 15, usl: 40 }, assessment), { type: 'array' });
    const summary = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['统计摘要'], { header: 1 });
    expect(summary).toContainEqual(['数据结构', '单值观测（I-MR）']);
    expect(summary.some((row) => row[0] === '子组数 k' || row[0] === '子组大小 n')).toBe(false);
    expect(summary.some((row) => row[0] === 'σ 组内 (MR̄/d₂(2))')).toBe(true);
  });

  it('Excel:R-only 摘要和展开明细都消费同一评估结果', () => {
    const wb = XLSX.read(buildXlsx(M, SPEC, a), { type: 'array' });
    const summaryRows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['统计摘要'], { header: 1 });
    const stability = summaryRows.map((r) => (r ?? []).join('|')).find((t) => t.includes('过程稳定性')) ?? '';
    expect(stability).toContain(`各图累计 ${a.chartPointCount} 个失控点`);
    expect(stability).toContain(`去重子组 ${a.uniqueAnalysisUnitCount} 个`);
    const violRows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['失控点'], { header: 1 });
    expect(violRows.length - 1).toBe(a.events.length);
    expect(violRows.slice(1).every((r) => r[1] === 'R')).toBe(true);
  });

  it('K2=12 Excel:摘要是 24 个图表点，失控点 sheet 也完整展开 24 行', () => {
    const model = k12Model();
    const assessment = assessSpcCharts(
      model,
      { ...OFF, r2: true },
      { ...DEFAULT_RULE_K, k2: 12 },
    );
    const wb = XLSX.read(buildXlsx(model, { lsl: -30, tgt: 0, usl: 30 }, assessment), { type: 'array' });
    const summaryRows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['统计摘要'], { header: 1 });
    const stability = summaryRows.map((row) => (row ?? []).join('|')).find((text) => text.includes('过程稳定性')) ?? '';
    const detailRows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['失控点'], { header: 1 }).slice(1);

    expect(assessment.chartPointCount).toBe(24);
    expect(assessment.events).toHaveLength(24);
    expect(stability).toContain('各图累计 24 个失控点');
    expect(detailRows).toHaveLength(24);
    expect(detailRows.map((row) => row[0])).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
    expect(detailRows.every((row) => row[1] === 'X̄' && row[2] === 2)).toBe(true);
  });

  it('规则全关时三种格式一致写受控', () => {
    const calm = assessSpcCharts(M, OFF, DEFAULT_RULE_K);
    expect(textReport(M, SPEC, calm)).toContain('未检出失控点');
    expect(buildHtmlReport(M, SPEC, calm)).toContain('未检出失控点');
    const wb = XLSX.read(buildXlsx(M, SPEC, calm), { type: 'array' });
    const violRows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['失控点'], { header: 1 });
    expect(violRows[1].join('')).toContain('未检出失控点');
  });

  it('常量数据的能力/AD 不可计算时，文本、HTML 和 Excel 仍保留 SPC 稳定性', () => {
    const constant = computeVarModel('常量.csv', ['a', 'b'], Array.from({ length: 20 }, () => [1, 1]));
    const assessment = assessSpcCharts(constant, OFF, DEFAULT_RULE_K);
    const spec = { lsl: 0, tgt: 1, usl: 2 };

    const text = textReport(constant, spec, assessment);
    expect(text).toContain('能力分析未运行');
    expect(text).toContain('未检出失控点');

    const html = buildHtmlReport(constant, spec, assessment);
    expect(html).toContain('能力分析未运行');
    expect(html).toContain('数据无可估计变异，正态性不可判定');
    expect(html).toContain('未检出失控点');

    const workbook = XLSX.read(buildXlsx(constant, spec, assessment), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['统计摘要'], { header: 1 });
    expect(rows.map((row) => row.join('|')).find((line) => line.includes('过程能力'))).toContain('未运行');
    expect(rows.map((row) => row.join('|')).find((line) => line.includes('过程稳定性'))).toContain('控制图无失控信号');
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

describe('判异明细行上限(v1.42.4 审计 P2:对抗性事件量不冻结导出)', () => {
  const M = rOnlyModel();
  function bigAssessment(count: number): SpcAssessment {
    const events = Array.from({ length: count }, (_, k) => ({ i: k, rule: 1, desc: '超出控制限', chart: 'X̄' }));
    return {
      locationLabel: 'X̄', dispersionLabel: 'R', locationPoints: count, dispersionPoints: 0,
      chartPointCount: count, analysisUnitLabel: '子组', uniqueAnalysisUnitCount: count,
      uniqueObservationCount: count, uniquePointCount: count, stable: false, events,
      locationViolIndexes: new Set<number>(), dispersionViolIndexes: new Set<number>(),
      verdictLine: `✗ X̄ 图检出 ${count} 个失控点，存在特殊原因变异`,
    };
  }

  it('Excel 失控点 sheet 超限截断并写明总数;未超限无截断行', () => {
    const total = MAX_XLSX_VIOLATION_ROWS + 3;
    const wb = XLSX.read(buildXlsx(M, SPEC, bigAssessment(total)), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['失控点'], { header: 1 });
    expect(rows.length).toBe(1 + MAX_XLSX_VIOLATION_ROWS + 1);
    expect(String(rows[rows.length - 1].join(''))).toContain(`共 ${total} 条判异事件`);
    const small = XLSX.read(buildXlsx(M, SPEC, bigAssessment(10)), { type: 'array' });
    const smallRows = XLSX.utils.sheet_to_json<(string | number)[]>(small.Sheets['失控点'], { header: 1 });
    expect(smallRows.length).toBe(11);
    expect(JSON.stringify(smallRows)).not.toContain('已截断');
  });

  it('HTML 明细表超限截断并写明总数;未超限无截断行', () => {
    const total = MAX_HTML_VIOLATION_ROWS + 5;
    const html = buildHtmlReport(M, SPEC, bigAssessment(total));
    expect((html.match(/超出控制限/g) ?? []).length).toBe(MAX_HTML_VIOLATION_ROWS);
    expect(html).toContain(`共 ${total} 条判异事件`);
    const small = buildHtmlReport(M, SPEC, bigAssessment(10));
    expect(small).not.toContain('已截断');
  });
});
