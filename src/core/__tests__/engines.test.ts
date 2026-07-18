/**
 * 新增引擎对拍 — ANOVA / Gage R&R / F 分布 / 变量模型 / 常数表 / CSV 解析。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
  it('观测单位缩放不改变 F / P，小量纲数据不被固定阈值误判为零方差', () => {
    const small = [[1e-7, 1.1e-7], [2e-7, 2.1e-7]];
    const scaled = small.map((group) => group.map((value) => value * 1e8));
    const a = oneWayAnova(small);
    const b = oneWayAnova(scaled);
    expect(a.fStat).toBeGreaterThan(0);
    expect(Number.isFinite(a.fStat)).toBe(true);
    expect(a.fStat).toBeCloseTo(b.fStat, 12);
    expect(a.pValue).toBeCloseTo(b.pValue, 12);
    expect(a.significant).toBe(b.significant);
  });
  it('所有观测加同一大常数不改变 F / P 或显著性结论', () => {
    const groups = [[25, 24, 25], [8, 16, 9], [12, 20, 28]];
    const offset = 1e15;
    const base = oneWayAnova(groups);
    const shifted = oneWayAnova(groups.map((group) => group.map((value) => value + offset)));
    expect(base.pValue).toBeLessThan(0.05);
    expect(shifted.fStat).toBeCloseTo(base.fStat, 12);
    expect(shifted.pValue).toBeCloseTo(base.pValue, 12);
    expect(shifted.significant).toBe(base.significant);
  });
  it('极大单位下零组内平方和保持 0，F/P 不被 0×Infinity 污染为 NaN', () => {
    const a = oneWayAnova([[1e200, 1e200], [2e200, 2e200]]);
    expect(a.errorSS).toBe(0);
    expect(a.fStat).toBe(Infinity);
    expect(a.pValue).toBe(0);
  });
});

describe('Gage R&R（交叉 ANOVA 法）', () => {
  const g = computeGageRR(gageStudyData(), { mode: 'width', value: GAGE_TOLERANCE });
  it('演示研究：合计 GRR < 10%（可接受）', () => {
    expect(g.totalGageRR).toBeGreaterThan(5);
    expect(g.totalGageRR).toBeLessThan(10);
    expect(g.totalGageRR).toBeCloseTo(8.776934972010649, 10);
    expect(g.verdict).toBe('acceptable');
    expect(g.interaction?.retained).toBe(false);
  });
  it('2×2×2 可手算交叉数据：不显著交互合并到重复性误差', () => {
    const handCalculated = [
      { part: 0, operator: 0, trial: 0, value: 10 },
      { part: 0, operator: 0, trial: 1, value: 12 },
      { part: 0, operator: 1, trial: 0, value: 11 },
      { part: 0, operator: 1, trial: 1, value: 13 },
      { part: 1, operator: 0, trial: 0, value: 20 },
      { part: 1, operator: 0, trial: 1, value: 22 },
      { part: 1, operator: 1, trial: 0, value: 21 },
      { part: 1, operator: 1, trial: 1, value: 23 },
    ];
    // 手算 ANOVA：MS_part=200, MS_operator=2, SS_interaction=0, SS_error=8。
    // p_interaction=1，缩减模型 MSE=(0+8)/(1+4)=1.6；因此
    // σ²_repeat=1.6, σ²_operator=(2-1.6)/4=0.1, σ²_part=(200-1.6)/4=49.6。
    const exact = computeGageRR(handCalculated, { mode: 'width', value: 100 });
    const exactVar = Object.fromEntries(exact.components.map((c) => [c.key, c.variance]));
    expect(exactVar.grr).toBeCloseTo(1.7, 12);
    expect(exactVar.repeatability).toBeCloseTo(1.6, 12);
    expect(exactVar.reproducibility).toBeCloseTo(0.1, 12);
    expect(exactVar.operator).toBeCloseTo(0.1, 12);
    expect(exactVar.part).toBeCloseTo(49.6, 12);
    expect(exactVar.total).toBeCloseTo(51.3, 12);
    expect(exact.totalGageRR).toBeCloseTo(Math.sqrt(1.7 / 51.3) * 100, 12);
    expect(exact.interaction).toMatchObject({ pValue: 1, retained: false, alpha: 0.05 });
    expect(exact.verdict).toBe('marginal');
  });
  it('显著交互保留，且平移/换单位不改变 F、p、%GRR', () => {
    const interactionStudy = [
      { part: 0, operator: 0, trial: 0, value: 0 },
      { part: 0, operator: 0, trial: 1, value: 2 },
      { part: 0, operator: 1, trial: 0, value: 9 },
      { part: 0, operator: 1, trial: 1, value: 11 },
      { part: 1, operator: 0, trial: 0, value: 9 },
      { part: 1, operator: 0, trial: 1, value: 11 },
      { part: 1, operator: 1, trial: 0, value: 0 },
      { part: 1, operator: 1, trial: 1, value: 2 },
    ];
    const base = computeGageRR(interactionStudy, { mode: 'width', value: 20 });
    expect(base.interaction?.retained).toBe(true);
    expect(base.interaction!.fStat).toBeCloseTo(81, 12);
    expect(base.interaction!.pValue).toBeLessThan(0.001);
    const baseVar = Object.fromEntries(base.components.map((c) => [c.key, c.variance]));
    expect(baseVar.grr).toBeCloseTo(82, 12);
    expect(baseVar.repeatability).toBeCloseTo(2, 12);
    expect(baseVar.reproducibility).toBeCloseTo(80, 12);
    expect(baseVar.operator).toBeCloseTo(0, 12);
    expect(baseVar.interaction).toBeCloseTo(80, 12);
    expect(baseVar.part).toBeCloseTo(0, 12);
    expect(baseVar.total).toBeCloseTo(82, 12);

    const shiftedScaled = computeGageRR(
      interactionStudy.map((row) => ({ ...row, value: 1_000_000 + row.value * 100 })),
      { mode: 'width', value: 2_000 },
    );
    expect(shiftedScaled.interaction!.fStat).toBeCloseTo(base.interaction!.fStat, 10);
    expect(shiftedScaled.interaction!.pValue).toBeCloseTo(base.interaction!.pValue, 12);
    expect(shiftedScaled.totalGageRR).toBeCloseTo(base.totalGageRR, 12);
    shiftedScaled.components.forEach((component, index) => {
      expect(component.variance).toBeCloseTo(base.components[index].variance * 10_000, 6);
      expect(component.pctTolerance).toBeCloseTo(base.components[index].pctTolerance!, 10);
    });
  });
  it('官方 Minitab 交叉 Gage 样例对拍：p=0.974 后删除交互并复现方差分量', () => {
    const fixture = readFileSync(new URL('./fixtures/gage-crossed-minitab.tsv', import.meta.url), 'utf8');
    const rows = fixture.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).slice(1);
    const operators = ['A', 'B', 'C'];
    const trials = new Map<string, number>();
    const observations = rows.map((line) => {
      const [partText, operatorText, valueText] = line.split('\t');
      const key = `${partText}:${operatorText}`;
      const trial = trials.get(key) ?? 0;
      trials.set(key, trial + 1);
      return { part: Number(partText) - 1, operator: operators.indexOf(operatorText), trial, value: Number(valueText) };
    });
    expect(observations).toHaveLength(90);
    const result = computeGageRR(observations, { mode: 'width', value: 8 });
    expect(result.interaction?.retained).toBe(false);
    expect(result.interaction!.pValue).toBeCloseTo(0.974, 3);
    const varByKey = Object.fromEntries(result.components.map((component) => [component.key, component.variance]));
    expect(varByKey.grr).toBeCloseTo(0.09143, 5);
    expect(varByKey.repeatability).toBeCloseTo(0.03997, 5);
    expect(varByKey.reproducibility).toBeCloseTo(0.05146, 5);
    expect(varByKey.operator).toBeCloseTo(0.05146, 5);
    expect(varByKey.part).toBeCloseTo(1.08645, 5);
    expect(varByKey.total).toBeCloseTo(1.17788, 5);
    expect(result.totalGageRR).toBeCloseTo(27.86, 2);
  });
  it('未给双侧公差时仍计算研究变异，%Tolerance 明确为 null', () => {
    const withoutTolerance = computeGageRR(gageStudyData(), null);
    expect(withoutTolerance.totalGageRR).toBeCloseTo(g.totalGageRR, 12);
    expect(withoutTolerance.components.every((component) => component.pctTolerance === null)).toBe(true);
  });
  it('%贡献相加 = 100（GRR + 部件间 = 合计）', () => {
    const grr = g.components.find((c) => c.key === 'grr')!;
    const part = g.components.find((c) => c.key === 'part')!;
    const total = g.components.find((c) => c.key === 'total')!;
    expect(grr.pctContribution + part.pctContribution).toBeCloseTo(100, 6);
    expect(total.pctContribution).toBeCloseTo(100, 6);
    expect(total.pctStudyVar).toBeCloseTo(100, 6);
  });
  it('零测量误差 → GRR = 0', () => {
    const data = [];
    for (let p = 0; p < 4; p++)
      for (let o = 0; o < 2; o++)
        for (let t = 0; t < 2; t++) data.push({ part: p, operator: o, trial: t, value: 10 + p });
    expect(computeGageRR(data, { mode: 'width', value: 1 }).totalGageRR).toBeCloseTo(0, 6);
  });

  const balancedStudy = () => {
    const data = [];
    for (let p = 0; p < 2; p++)
      for (let o = 0; o < 2; o++)
        for (let t = 0; t < 2; t++) data.push({ part: p, operator: o, trial: t, value: 10 + p + o * 0.1 + t * 0.01 });
    return data;
  };

  it('拒绝非有限测量值、编号与非正/非有限公差', () => {
    const data = balancedStudy();
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      expect(() => computeGageRR(data.map((row, i) => i === 0 ? { ...row, value } : row), { mode: 'width', value: 1 })).toThrow('测量值必须全部为有限数值');
    }
    expect(() => computeGageRR(data.map((row, i) => i === 0 ? { ...row, trial: Infinity } : row), { mode: 'width', value: 1 })).toThrow('编号必须全部为有限数值');
    for (const tolerance of [0, -1]) {
      expect(() => computeGageRR(data, { mode: 'width', value: tolerance })).toThrow('公差宽度必须大于 0');
    }
    for (const tolerance of [Number.NaN, Infinity]) {
      expect(() => computeGageRR(data, { mode: 'width', value: tolerance })).toThrow('公差必须是有限数值');
    }
    expect(() => computeGageRR(data.map((row, i) => i === 0 ? { ...row, part: -1 } : row), { mode: 'width', value: 1 })).toThrow('非负安全整数');
    expect(() => computeGageRR(data.map((row, i) => i === 0 ? { ...row, operator: 0.5 } : row), { mode: 'width', value: 1 })).toThrow('非负安全整数');
  });

  it('至少要求 2 个部件 × 2 次重复试验;单操作员合法(退化单因子模型)', () => {
    const data = balancedStudy();
    expect(() => computeGageRR(data.filter((row) => row.part === 0), { mode: 'width', value: 1 })).toThrow('至少需要 2 个部件');
    expect(() => computeGageRR(data.filter((row) => row.trial === 0), { mode: 'width', value: 1 })).toThrow('2 次重复试验');
    const singleOperator = computeGageRR(data.filter((row) => row.operator === 0), { mode: 'width', value: 1 });
    expect(singleOperator.interaction).toBeNull();
    expect(singleOperator.components.map((component) => component.key)).toEqual(['grr', 'repeatability', 'part', 'total']);
    const grrRow = singleOperator.components.find((component) => component.key === 'grr')!;
    const repeatRow = singleOperator.components.find((component) => component.key === 'repeatability')!;
    expect(grrRow.variance).toBeCloseTo(repeatRow.variance, 12);
  });

  it('拒绝缺失、重复或不等重复的交叉组合', () => {
    const data = balancedStudy();
    expect(() => computeGageRR(data.slice(1), { mode: 'width', value: 1 })).toThrow('完整且等重复');
    expect(() => computeGageRR([...data, { ...data[0] }], { mode: 'width', value: 1 })).toThrow('组合不能重复');

    const unbalanced = data.filter((row) => !(row.part === 1 && row.operator === 1 && row.trial === 1));
    unbalanced.push({ part: 1, operator: 1, trial: 2, value: 11.12 });
    expect(() => computeGageRR(unbalanced, { mode: 'width', value: 1 })).toThrow('完整且等重复');
  });

  it('拒绝 0-based 水平编号缺号，并拒绝合计变异为 0', () => {
    const skippedTrial = balancedStudy().map((row) => ({ ...row, trial: row.trial * 2 }));
    expect(() => computeGageRR(skippedTrial, { mode: 'width', value: 1 })).toThrow('重复试验编号必须从 0 开始连续');
    expect(() => computeGageRR(balancedStudy().map((row) => ({ ...row, value: 10 })), { mode: 'width', value: 1 })).toThrow('合计变异为 0');
    expect(() => computeGageRR(balancedStudy().map((row) => ({ ...row, value: 0.1 })), { mode: 'width', value: 1 })).toThrow('合计变异为 0');
  });
});

describe('控制图常数表 n=2..10', () => {
  it('用独立 d2/d3/c4 基础表与公开公式核对全部 72 个单元格', () => {
    const text = readFileSync(new URL('./fixtures/spc-control-constant-bases.tsv', import.meta.url), 'utf8');
    const rows = text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).slice(1);
    expect(rows).toHaveLength(9);
    expect(rows.map((row) => Number(row.split('\t')[0]))).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const close = (actual: number, expected: number, tolerance: number) => {
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
    };
    for (const row of rows) {
      const [nText, d2Text, d3Text, c4Text] = row.split('\t');
      const n = Number(nText);
      const d2 = Number(d2Text);
      const d3 = Number(d3Text);
      const c4 = Number(c4Text);
      const expected = {
        d2,
        c4,
        A2: 3 / (d2 * Math.sqrt(n)),
        A3: 3 / (c4 * Math.sqrt(n)),
        D3: Math.max(0, 1 - (3 * d3) / d2),
        D4: 1 + (3 * d3) / d2,
        B3: Math.max(0, 1 - (3 * Math.sqrt(1 - c4 ** 2)) / c4),
        B4: 1 + (3 * Math.sqrt(1 - c4 ** 2)) / c4,
      };
      const actual = CONTROL_CONSTANTS[n];
      expect(actual, `n=${n}`).toBeDefined();
      close(actual.d2, expected.d2, 0.0006);
      close(actual.c4, expected.c4, 0.00006);
      for (const key of ['A2', 'A3', 'D3', 'D4', 'B3', 'B4'] as const) {
        close(actual[key], expected[key], 0.0015);
      }
    }
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
  it('>10 数值列可作为原始宽表保存，但不会静默当作行式子组计算', () => {
    const m = computeVarModel('t', Array.from({ length: 11 }, (_, i) => `c${i + 1}`), [Array(11).fill(1), Array(11).fill(2)]);
    expect(m.n).toBe(11);
    expect(m.hasSubgroups).toBe(false);
    expect(m.indiv).toHaveLength(22);
    expect(m.uclX).toBeNaN();
    expect(m.uclR).toBeNaN();
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
  it('超过 10 个数值列仍可导入（列数不等于子组大小）', () => {
    const line = Array.from({ length: 11 }, (_, i) => i + 1).join(',');
    const r = parseMatrix(line + '\n' + line + '\n' + line);
    if ('error' in r) throw new Error(r.error);
    expect(r.colNames).toHaveLength(11);
    expect(r.rows).toHaveLength(3);
  });
});
