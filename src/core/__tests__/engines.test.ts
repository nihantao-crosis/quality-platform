/**
 * 新增引擎对拍 — ANOVA / Gage R&R / F 分布 / 变量模型 / 常数表 / CSV 解析。
 */
import { describe, it, expect } from 'vitest';
import { fCdf, betai } from '../basicMath';
import { oneWayAnova } from '../anova';
import { computeGageRR } from '../gage';
import { CONTROL_CONSTANTS } from '../spc';
import { computeVarModel } from '../model';
import { parseMatrix } from '../csv';
import { anovaGroups, gageStudyData, GAGE_TOLERANCE, buildData } from '../sampleData';

describe('F 分布 / 不完全贝塔', () => {
  it('教科书值：F(2,6)=3 → CDF=0.875（p=0.125）；F(1,1) 中位数=1', () => {
    expect(fCdf(3, 2, 6)).toBeCloseTo(0.875, 6);
    expect(fCdf(1, 1, 1)).toBeCloseTo(0.5, 6);
  });
  it('betai 对称性 I_x(a,b) = 1 − I_{1−x}(b,a)', () => {
    expect(betai(2, 5, 0.3)).toBeCloseTo(1 - betai(5, 2, 0.7), 10);
  });
});

describe('单因子 ANOVA', () => {
  it('手算例：均值 2/3/4、组内方差 1 → F=3, p=0.125', () => {
    const a = oneWayAnova([[1, 2, 3], [2, 3, 4], [3, 4, 5]]);
    expect(a.fStat).toBeCloseTo(3, 10);
    expect(a.factorSS).toBeCloseTo(6, 10);
    expect(a.errorSS).toBeCloseTo(6, 10);
    expect(a.pValue).toBeCloseTo(0.125, 4);
    expect(a.significant).toBe(false);
  });
  it('演示数据（种子 3927）：P ≈ 0.012 显著，设备 B 均值最高', () => {
    const groups = anovaGroups();
    const a = oneWayAnova(groups.map((g) => g.vals));
    expect(a.pValue).toBeGreaterThan(0.005);
    expect(a.pValue).toBeLessThan(0.02);
    expect(a.significant).toBe(true);
    const means = groups.map((g) => g.vals.reduce((x, y) => x + y, 0) / g.vals.length);
    expect(Math.max(...means)).toBe(means[1]); // 设备 B
  });
});

describe('Gage R&R（交叉 ANOVA 法）', () => {
  const g = computeGageRR(gageStudyData(), GAGE_TOLERANCE);
  it('演示研究：合计 GRR < 10%（可接受）', () => {
    expect(g.totalGageRR).toBeGreaterThan(5);
    expect(g.totalGageRR).toBeLessThan(10);
    expect(g.verdict).toBe('acceptable');
  });
  it('%贡献相加 = 100（GRR + 部件间 = 合计）', () => {
    const grr = g.components[0];
    const part = g.components[3];
    const total = g.components[4];
    expect(grr.pctContribution + part.pctContribution).toBeCloseTo(100, 6);
    expect(total.pctContribution).toBeCloseTo(100, 6);
    expect(total.pctStudyVar).toBeCloseTo(100, 6);
  });
  it('零测量误差 → GRR = 0', () => {
    const data = [];
    for (let p = 0; p < 4; p++)
      for (let o = 0; o < 2; o++)
        for (let t = 0; t < 2; t++) data.push({ part: p, operator: o, trial: t, value: 10 + p });
    expect(computeGageRR(data, 1).totalGageRR).toBeCloseTo(0, 6);
  });
});

describe('控制图常数表 n=2..10', () => {
  it('覆盖 n=2..10，关键值正确', () => {
    for (let n = 2; n <= 10; n++) expect(CONTROL_CONSTANTS[n]).toBeDefined();
    expect(CONTROL_CONSTANTS[2].A2).toBeCloseTo(1.88, 3);
    expect(CONTROL_CONSTANTS[5].d2).toBeCloseTo(2.326, 3);
    expect(CONTROL_CONSTANTS[10].D4).toBeCloseTo(1.777, 3);
  });
});

describe('变量数据模型 computeVarModel', () => {
  it('小矩阵手算：2×2', () => {
    const m = computeVarModel('t.csv', ['a', 'b'], [[1, 3], [2, 4]]);
    expect(m.subs[0].mean).toBe(2);
    expect(m.subs[1].mean).toBe(3);
    expect(m.rbar).toBe(2);
    expect(m.xbarbar).toBe(2.5);
    expect(m.uclX).toBeCloseTo(2.5 + 1.88 * 2, 10);
    expect(m.uclR).toBeCloseTo(3.267 * 2, 10);
    expect(m.sigmaWithin).toBeCloseTo(2 / 1.128, 10);
  });
  it('n=5 时与原型 buildData 数值一致', () => {
    const D = buildData();
    const m = computeVarModel('demo', ['1', '2', '3', '4', '5'], D.subs.map((s) => s.vals));
    expect(m.xbarbar).toBeCloseTo(D.xbarbar, 12);
    expect(m.uclX).toBeCloseTo(D.uclX, 12);
    expect(m.uclR).toBeCloseTo(D.uclR, 12);
    expect(m.sbar).toBeCloseTo(D.sbar, 12);
    expect(m.uclS).toBeCloseTo(D.uclS, 12);
    expect(m.sigmaWithin).toBeCloseTo(D.sigmaWithin, 12);
    expect(m.oSd).toBeCloseTo(D.oSd, 12);
  });
  it('单列数据：I-MR 可用、无子组', () => {
    const m = computeVarModel('t', ['x'], [[1], [2], [4], [3]]);
    expect(m.hasSubgroups).toBe(false);
    expect(m.mrbar).toBeCloseTo((1 + 2 + 1) / 3, 10);
    expect(m.sigmaWithin).toBeCloseTo(m.iSig, 12);
  });
  it('n>10 拒绝', () => {
    expect(() => computeVarModel('t', Array(11).fill('c'), [Array(11).fill(1), Array(11).fill(2)])).toThrow();
  });
});

describe('CSV / 剪贴板解析', () => {
  it('带表头逗号分隔', () => {
    const r = parseMatrix('直径1,直径2,备注\n25.01,24.99,ok\n24.98,25.03,ok');
    if ('error' in r) throw new Error(r.error);
    expect(r.colNames).toEqual(['直径1', '直径2']);
    expect(r.rows).toEqual([[25.01, 24.99], [24.98, 25.03]]);
    expect(r.droppedCols).toBe(1);
  });
  it('无表头 Tab 分隔 → C1..Cn', () => {
    const r = parseMatrix('1\t2\n3\t4\n5\t6');
    if ('error' in r) throw new Error(r.error);
    expect(r.colNames).toEqual(['C1', 'C2']);
    expect(r.rows.length).toBe(3);
  });
  it('跳过含非法值的行（列 ≥80% 数值则保留列、剔坏行）', () => {
    const r = parseMatrix('a,b\n1,2\n3,4\nx,6\n7,8\n9,10');
    if ('error' in r) throw new Error(r.error);
    expect(r.colNames).toEqual(['a', 'b']);
    expect(r.rows).toEqual([[1, 2], [3, 4], [7, 8], [9, 10]]);
    expect(r.skippedRows).toBe(1);
  });
  it('列数超限报错', () => {
    const line = Array.from({ length: 11 }, (_, i) => i + 1).join(',');
    const r = parseMatrix(line + '\n' + line + '\n' + line);
    expect('error' in r).toBe(true);
  });
});
