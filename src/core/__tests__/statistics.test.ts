/**
 * 对拍测试 — 期望值来自交接文档 core-skeleton/README.md「关键校验值」
 * 与原型内置样本数据（种子 20260601）。
 */
import { describe, it, expect } from 'vitest';
import { phi, invNorm, binomCdf, median, quantile } from '../basicMath';
import { evalRules, DEFAULT_RULES } from '../spc';
import { computeCapability } from '../capability';
import { analyzeDoe, mainEffectMeans, interactionMeans } from '../doe';
import { aqlPlan, rqlFor, producerRiskPct, codeLetterGB, codeLetterShift } from '../aql';
import { buildData, anovaGroups } from '../sampleData';
import { calcKey, CALC_INIT, type CalcState } from '../calculator';

const M = buildData();

describe('基础数学', () => {
  it('phi(0) = 0.5, phi(1.96) ≈ 0.975', () => {
    expect(phi(0)).toBeCloseTo(0.5, 6);
    expect(phi(1.96)).toBeCloseTo(0.975, 3);
  });
  it('invNorm 与 phi 互逆', () => {
    for (const p of [0.01, 0.1, 0.5, 0.9, 0.999]) {
      expect(phi(invNorm(p))).toBeCloseTo(p, 4);
    }
  });
  it('binomCdf 边界与已知值', () => {
    expect(binomCdf(20, 20, 0.5)).toBe(1);
    expect(binomCdf(0, 10, 0.1)).toBeCloseTo(0.9 ** 10, 10);
    expect(binomCdf(1, 20, 0.01)).toBeGreaterThan(0.95); // AQL n=20 Ac=1 依据
  });
  it('median / quantile', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
});

describe('样本数据（种子 20260601）与 SPC', () => {
  it('25 子组 × 5 测量 = 125 观测', () => {
    expect(M.subs.length).toBe(25);
    expect(M.all.length).toBe(125);
  });
  it('X̄-R 控制限关系成立', () => {
    expect(M.uclX).toBeCloseTo(M.xbarbar + 0.577 * M.rbar, 10);
    expect(M.uclR).toBeCloseTo(2.114 * M.rbar, 10);
    expect(M.sigmaWithin).toBeCloseTo(M.rbar / 2.326, 10);
  });
  it('注入的偏移被判异检出（子组 16–18 上移、22 下移 → 有失控点）', () => {
    const sig = (M.uclX - M.xbarbar) / 3;
    const { list } = evalRules(M.means, M.xbarbar, sig, DEFAULT_RULES);
    expect(list.length).toBeGreaterThan(0);
    const r1Points = list.filter((v) => v.rule === 1).map((v) => v.i + 1);
    // 原型仪表盘/告警描述：16–18 段与 22 附近越限
    expect(r1Points.some((i) => i >= 16 && i <= 18)).toBe(true);
    expect(r1Points).toContain(22);
  });
  it('关闭全部准则 → 无失控点', () => {
    const sig = (M.uclX - M.xbarbar) / 3;
    const { list } = evalRules(M.means, M.xbarbar, sig, { r1: false, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false });
    expect(list.length).toBe(0);
  });
});

describe('过程能力（默认规格 24.90/25.00/25.10）', () => {
  const cap = computeCapability(M.all, M.sigmaWithin, { lsl: 24.9, tgt: 25.0, usl: 25.1 });
  it('Cpk ≈ 1.36（关键校验值）', () => {
    expect(cap.cpk).toBeGreaterThan(1.30);
    expect(cap.cpk).toBeLessThan(1.42);
    expect(cap.cpk).toBeCloseTo(M.Cpk, 10);
  });
  it('判定为能力充足', () => {
    expect(cap.verdict).toBe('sufficient');
  });
  it('Cp ≥ Cpk，Pp ≥ Ppk', () => {
    expect(cap.cp).toBeGreaterThanOrEqual(cap.cpk);
    expect(cap.pp).toBeGreaterThanOrEqual(cap.ppk);
  });
  it('西格玛水平 = Z.bench + 1.5', () => {
    expect(cap.sigmaLevel).toBeCloseTo(cap.zBench + 1.5, 10);
  });
});

describe('DOE 2³ 全因子 + Lenth', () => {
  const r = analyzeDoe();
  it('A 温度、C 时间显著；交互项不显著（关键校验值）', () => {
    const sig = r.terms.filter((t) => t.sig).map((t) => t.name);
    expect(sig).toContain('A 温度');
    expect(sig).toContain('C 时间');
    expect(sig).not.toContain('A×B');
    expect(sig).not.toContain('A×C');
    expect(sig).not.toContain('B×C');
  });
  it('效应值与原型一致（A=13.5, B=3.5, C=7.0）', () => {
    const by = Object.fromEntries(r.terms.map((t) => [t.name, t.v]));
    expect(by['A 温度']).toBeCloseTo(13.5, 10);
    expect(by['B 压力']).toBeCloseTo(3.5, 10);
    expect(by['C 时间']).toBeCloseTo(7.0, 10);
  });
  it('主效应/交互图均值与原型硬编码一致', () => {
    const me = mainEffectMeans();
    expect(me[0]).toMatchObject({ lo: 46.75, hi: 60.25 });
    expect(me[1]).toMatchObject({ lo: 51.75, hi: 55.25 });
    expect(me[2]).toMatchObject({ lo: 50.0, hi: 57.0 });
    expect(interactionMeans()).toEqual({ c00: 45, c10: 58.5, c01: 48.5, c11: 62 });
  });
});

describe('AQL 抽样方案', () => {
  it('N=120, 水平 II, AQL=1.0 → 真表:初始 F,↑箭头改档为 E/n=13/Ac=0/Re=1', () => {
    expect(aqlPlan(120, 'II', 1.0)).toEqual({ code: 'E', n: 13, ac: 0, re: 1 });
  });
  it('初始字码(未解析箭头前):位移近似 I/III 偏移 ∓2', () => {
    expect(codeLetterShift(120, 'I')).toBe('D');
    expect(codeLetterShift(120, 'III')).toBe('H');
  });
  it('初始字码:国标字码表 N=120 I=D / II=F / III=G', () => {
    expect(codeLetterGB(120, 'I')).toBe('D');
    expect(codeLetterGB(120, 'II')).toBe('F');
    expect(codeLetterGB(120, 'III')).toBe('G');
  });
  it('RQL 处 Pa ≤ 10%,生产方风险 α < 5%(以 K 方案 N=2000/II/1.0)', () => {
    const plan = aqlPlan(2000, 'II', 1.0); // K/125/3/4(直取,无箭头)
    expect(plan).toEqual({ code: 'K', n: 125, ac: 3, re: 4 });
    const rql = rqlFor(plan);
    expect(binomCdf(plan.ac, plan.n, rql)).toBeLessThanOrEqual(0.1);
    expect(producerRiskPct(plan, 1.0)).toBeLessThan(5);
  });
});

describe('ANOVA 演示数据', () => {
  it('三组 × 12 观测，设备 B 均值偏高', () => {
    const g = anovaGroups();
    expect(g.length).toBe(3);
    g.forEach((x) => expect(x.vals.length).toBe(12));
    const means = g.map((x) => x.vals.reduce((a, b) => a + b, 0) / 12);
    expect(means[1]).toBeGreaterThan(means[0]);
    expect(means[1]).toBeGreaterThan(means[2]);
  });
});

describe('计算器（关键校验值 144 ÷ 12 = 12）', () => {
  const press = (keys: string[]) => keys.reduce<CalcState>((s, k) => calcKey(s, k), CALC_INIT);
  it('144 ÷ 12 = 12', () => {
    expect(press(['1', '4', '4', '÷', '1', '2', '=']).disp).toBe('12');
  });
  it('连算 2 + 3 × … 按顺序结合：2+3=5, ×4=20', () => {
    expect(press(['2', '+', '3', '×', '4', '=']).disp).toBe('20');
  });
  it('小数、正负号、退格、清除', () => {
    expect(press(['1', '.', '5', '±']).disp).toBe('-1.5');
    expect(press(['1', '2', '⌫']).disp).toBe('1');
    expect(press(['9', 'C']).disp).toBe('0');
  });
  it('除零返回 0（原型行为）', () => {
    expect(press(['5', '÷', '0', '=']).disp).toBe('0');
  });
});
