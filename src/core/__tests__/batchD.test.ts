/** 批次D:Nelson 判异准则 4/6/7/8 + AQL 国标查表 / 位移近似。 */
import { describe, it, expect } from 'vitest';
import { evalRules, aqlPlan, codeLetterGB, codeLetterShift, CODE_LETTER_TABLE, N_BY_CODE, acceptNumber, acceptNumberGB, PREFERRED_AC } from '../index';

const OFF = { r1: false, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
const rulesOnly = (k: 'r4' | 'r6' | 'r7' | 'r8') => ({ ...OFF, [k]: true });

describe('Nelson 准则 4:连续 14 点上下交替', () => {
  it('14 点严格交替 → 检出,全部入 viol', () => {
    const data = Array.from({ length: 14 }, (_, i) => (i % 2 === 0 ? 0 : 10));
    const { viol, list } = evalRules(data, 5, 100, rulesOnly('r4'));
    expect(list.some((x) => x.rule === 4)).toBe(true);
    expect(viol.size).toBe(14);
  });
  it('13 点交替 → 不检出', () => {
    const data = Array.from({ length: 13 }, (_, i) => (i % 2 === 0 ? 0 : 10));
    expect(evalRules(data, 5, 100, rulesOnly('r4')).list.length).toBe(0);
  });
});

describe('Nelson 准则 6:相邻 5 点中 4 点越 1σ(同侧)', () => {
  it('检出并记实际越界点', () => {
    const { viol, list } = evalRules([2, 2, 2, 0.5, 2], 0, 1, rulesOnly('r6'));
    expect(list.some((x) => x.rule === 6)).toBe(true);
    expect([...viol].sort((a, b) => a - b)).toEqual([0, 1, 2, 4]); // 0.5 未越 1σ,不入
  });
});

describe('Nelson 准则 7:连续 15 点全在 1σ 内', () => {
  it('15 点贴近中心线 → 检出', () => {
    const data = Array.from({ length: 15 }, (_, i) => (i % 2 === 0 ? 0.3 : -0.3));
    expect(evalRules(data, 0, 1, rulesOnly('r7')).list.some((x) => x.rule === 7)).toBe(true);
  });
});

describe('Nelson 准则 8:连续 8 点全在 1σ 外(两侧皆可)', () => {
  it('8 点两侧越 1σ → 检出', () => {
    const data = [2, -2, 2, -2, 2, -2, 2, -2];
    expect(evalRules(data, 0, 1, rulesOnly('r8')).list.some((x) => x.rule === 8)).toBe(true);
  });
});

describe('AQL 字码判定:国标查表 vs 位移近似', () => {
  it('N=120 国标查表 I=D / II=F / III=G', () => {
    expect(codeLetterGB(120, 'I')).toBe('D');
    expect(codeLetterGB(120, 'II')).toBe('F');
    expect(codeLetterGB(120, 'III')).toBe('G'); // 位移近似会给 H,国标为 G
  });
  it('N=120 位移近似 III=H(与国标不同)', () => {
    expect(codeLetterShift(120, 'III')).toBe('H');
    expect(codeLetterGB(120, 'III')).not.toBe(codeLetterShift(120, 'III'));
  });
  it('aqlPlan 默认走国标查表', () => {
    expect(aqlPlan(120, 'III', 1.0).code).toBe('G');
    expect(aqlPlan(120, 'III', 1.0, 'shift').code).toBe('H');
  });
  it('大批量国标查表可达 P/Q/R,且 N_BY_CODE 有定义', () => {
    const codeIII = codeLetterGB(600000, 'III');
    expect(codeIII).toBe('R');
    expect(N_BY_CODE[codeIII]).toBe(2000);
    expect(CODE_LETTER_TABLE[CODE_LETTER_TABLE.length - 1].hi).toBe(Infinity);
  });
});

describe('AQL 接收数·优先数近似(非国标查表)', () => {
  // 注:这是"二项 + 吸附到优先数列"的近似,不是 GB/T 2828.1 表 2-A 逐格查表。
  // 外部审核(Codex/Grok)对拍真表:部分格巧合一致,部分格不符。此处如实记录,不再谎称"国标锚点"。
  it('与真表一致的格(巧合)', () => {
    expect(acceptNumberGB(80, 2.5)).toBe(5);   // J/2.5 真表=5
    expect(acceptNumberGB(200, 2.5)).toBe(10); // L/2.5 真表=10
    expect(acceptNumberGB(315, 2.5)).toBe(14); // M/2.5 真表=14
  });
  it('与真表不符的格(近似的已知偏差,待真表 2-A 落地修正)', () => {
    expect(acceptNumberGB(20, 1.0)).toBe(1);   // 近似=1,但真表 F/1.0=0(↑箭头→E 档 n=13)
    expect(acceptNumberGB(500, 4.0)).toBe(30); // 近似=30,但真表 N/4.0=21
    expect(acceptNumberGB(32, 2.5)).toBe(2);   // 近似=2,但真表 G/2.5=3
  });
  it('大样本处 Ac 吸附到优先数列,与二项不同', () => {
    expect(acceptNumber(200, 2.5)).toBe(9);    // 二项给非标数
    expect(acceptNumberGB(200, 2.5)).toBe(10); // 国标吸附到优先数
    // 结果必在优先数列内(或极端回落)
    for (const [n, a] of [[50, 4.0], [125, 2.5], [500, 1.5]] as [number, number][]) {
      expect(PREFERRED_AC.includes(acceptNumberGB(n, a))).toBe(true);
    }
  });
  it('aqlPlan 默认走国标优先数列;可切二项', () => {
    // L(200) 落在字码 III 的某档;直接用大样本档验证方法差异
    expect(aqlPlan(35000, 'II', 2.5, 'gb', 'gb').ac).toBe(acceptNumberGB(N_BY_CODE[codeLetterGB(35000, 'II')], 2.5));
    const p1 = aqlPlan(150000, 'III', 4.0, 'gb', 'gb');
    const p2 = aqlPlan(150000, 'III', 4.0, 'gb', 'binom');
    expect(PREFERRED_AC.includes(p1.ac)).toBe(true);
    expect(p1.ac).toBeGreaterThanOrEqual(p2.ac); // 国标吸附 ≥ 二项
  });
});
