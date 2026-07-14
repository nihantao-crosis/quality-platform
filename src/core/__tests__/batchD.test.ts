/** 批次D:Nelson 判异准则 4/6/7/8 + AQL 国标查表 / 位移近似。 */
import { describe, it, expect } from 'vitest';
import {
  evalRules, aqlPlan, masterPlan2A, codeLetterGB, codeLetterShift, CODE_LETTER_TABLE, N_BY_CODE,
  rqlFor, rqlForResult, binomCdf, MAX_LOT_SIZE,
} from '../index';

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
  it('aqlPlan 默认字码法用 codeLetterGB(与 shift 在水平 III 分叉,守护默认不被改回)', () => {
    // codeLetterGB(120,'III')=G、codeLetterShift(120,'III')=H → 经表 2-A 解析结果不同
    expect(aqlPlan(120, 'III', 2.5)).toEqual({ code: 'G', n: 32, ac: 2, re: 3 });
    expect(aqlPlan(120, 'III', 2.5, 'shift')).toEqual({ code: 'H', n: 50, ac: 3, re: 4 });
  });
  it('大批量国标查表可达 P/Q/R,且 N_BY_CODE 有定义', () => {
    const codeIII = codeLetterGB(600000, 'III');
    expect(codeIII).toBe('R');
    expect(N_BY_CODE[codeIII]).toBe(2000);
    expect(CODE_LETTER_TABLE[CODE_LETTER_TABLE.length - 1].hi).toBe(Infinity);
  });
  it('UI 可用的安全整数批量覆盖 500,001+ 最后档', () => {
    expect(codeLetterGB(500001, 'II')).toBe('Q');
    expect(codeLetterGB(500001, 'III')).toBe('R');
    expect(codeLetterGB(MAX_LOT_SIZE, 'III')).toBe('R');
    expect(aqlPlan(500001, 'III', 0.65)).toEqual({ code: 'R', n: 2000, ac: 21, re: 22 });
  });
});

describe('AQL 接收数·GB/T 2828.1 表 2-A 真查表(箭头已解析)', () => {
  it('masterPlan2A 关键锚点(Codex 转录 / Grok 复核)', () => {
    expect(masterPlan2A('F', 1.0)).toEqual({ code: 'E', n: 13, ac: 0, re: 1 }); // ↑箭头改档
    expect(masterPlan2A('K', 1.0)).toEqual({ code: 'K', n: 125, ac: 3, re: 4 });
    expect(masterPlan2A('L', 2.5)).toEqual({ code: 'L', n: 200, ac: 10, re: 11 });
    expect(masterPlan2A('G', 2.5)).toEqual({ code: 'G', n: 32, ac: 2, re: 3 });
    expect(masterPlan2A('N', 4.0)).toEqual({ code: 'M', n: 315, ac: 21, re: 22 }); // ↑箭头改档
    expect(masterPlan2A('A', 0.65)).toEqual({ code: 'F', n: 20, ac: 0, re: 1 }); // ↓箭头改档
    // AQL 1.5 列(此前无覆盖)
    expect(masterPlan2A('K', 1.5)).toEqual({ code: 'K', n: 125, ac: 5, re: 6 });
    // AQL 6.5 列(v1.29 新增,direct/↓/↑ 三类)
    expect(masterPlan2A('K', 6.5)).toEqual({ code: 'K', n: 125, ac: 14, re: 15 });
    expect(masterPlan2A('C', 6.5)).toEqual({ code: 'D', n: 8, ac: 1, re: 2 }); // ↓箭头改档
    expect(masterPlan2A('B', 6.5)).toEqual({ code: 'A', n: 2, ac: 0, re: 1 }); // ↑箭头改档
  });
  it('样本量 ≥ 批量 → 转 100% 全检(n 夹到批量 + fullInspect 标志)', () => {
    // 批量 8(水平 II→字码 A),AQL 0.65 查表 n=20 > 8 → 全检
    expect(aqlPlan(8, 'II', 0.65)).toEqual({ code: 'F', n: 8, ac: 0, re: 1, fullInspect: true });
    // 批量足够大时不触发
    expect(aqlPlan(2000, 'II', 1.0).fullInspect).toBeUndefined();
  });
  it('全检不计算抽样 RQL，数值兼容接口不返回伪边界', () => {
    const plan = aqlPlan(8, 'II', 0.65);
    expect(rqlForResult(plan)).toMatchObject({ status: 'not-applicable', reason: 'full-inspection', p: null });
    expect(rqlFor(plan)).toBeNaN();
  });
  it('N=8/III/AQL4.0:RQL 超过 40%，不得把搜索上限虚报为 β=10%', () => {
    const plan = aqlPlan(8, 'III', 4.0);
    expect(plan).toEqual({ code: 'B', n: 3, ac: 0, re: 1 });

    const limited = rqlForResult(plan, 0.1, 0.4);
    expect(limited.status).toBe('not-reached');
    if (limited.status === 'not-reached') expect(limited.paAtMax).toBeCloseTo(0.216, 12);

    const result = rqlForResult(plan);
    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.p).toBeGreaterThan(0.53);
      expect(result.p).toBeLessThan(0.54);
      expect(result.pa).toBeLessThanOrEqual(0.1);
      expect(binomCdf(plan.ac, plan.n, result.p)).toBeLessThanOrEqual(0.1);
      expect(rqlFor(plan)).toBeCloseTo(result.p, 12);
    }
  });
  it('aqlPlan 默认走真表(箭头会改字码/样本量)', () => {
    // N=120·II·AQL1.0:初始 F,↑ 后为 E/13/0/1(旧近似错给 F/20/1/2)
    expect(aqlPlan(120, 'II', 1.0)).toEqual({ code: 'E', n: 13, ac: 0, re: 1 });
    expect(aqlPlan(2000, 'II', 1.0)).toEqual({ code: 'K', n: 125, ac: 3, re: 4 });
    expect(aqlPlan(5000, 'II', 2.5)).toEqual({ code: 'L', n: 200, ac: 10, re: 11 });
  });
  it('二项近似模式仍可切换(与真表不同)', () => {
    expect(aqlPlan(120, 'II', 1.0, 'gb', 'binom')).toEqual({ code: 'F', n: 20, ac: 1, re: 2 });
  });
  it('AQL 不在主表覆盖范围 → masterPlan2A 返回 null(aqlPlan 回落二项)', () => {
    expect(masterPlan2A('F', 10.0)).toBeNull();
    expect(aqlPlan(120, 'II', 10.0).code).toBe('F'); // 回落用初始字码 + 二项
  });
});
