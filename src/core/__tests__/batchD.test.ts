/** 批次D:Nelson 判异准则 4/6/7/8 + AQL 国标查表 / 位移近似。 */
import { describe, it, expect } from 'vitest';
import { evalRules, aqlPlan, codeLetterGB, codeLetterShift, CODE_LETTER_TABLE, N_BY_CODE } from '../index';

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
