/** Nelson 准则定义表:八条元数据与判异边界均有独立锚点。 */
import { describe, it, expect } from 'vitest';
import { RULE_DEFS, evalRules, type NelsonRules, type RuleNo } from '../../core';

/**
 * 测试侧独立黄金值：不从 RULE_DEFS 派生，防止业务定义与断言同源自证。
 * 精确锁定每条准则的窗口点数、σ 区域、同侧/两侧和趋势语义。
 */
const GOLDEN_RULE_DEFS = {
  1: { name: '准则 1', def: '1 点落在中心线任一侧 3σ 之外', points: '1 点', source: 'Nelson 1984 / Minitab 检验 1' },
  2: { name: '准则 2', def: '连续 9 点落在中心线同一侧', points: '9 点', source: 'Nelson 1984 / Minitab 检验 2' },
  3: { name: '准则 3', def: '连续 6 点持续上升或持续下降', points: '6 点', source: 'Nelson 1984 / Minitab 检验 3' },
  4: { name: '准则 4', def: '连续 14 点上下交替', points: '14 点', source: 'Nelson 1984 / Minitab 检验 4' },
  5: { name: '准则 5', def: '相邻 3 点中有 2 点落在同侧 2σ 区之外', points: '3 中 2', source: 'Nelson 1984 / Minitab 检验 5' },
  6: { name: '准则 6', def: '相邻 5 点中有 4 点落在同侧 1σ 区之外', points: '5 中 4', source: 'Nelson 1984 / Minitab 检验 6' },
  7: { name: '准则 7', def: '连续 15 点全部落在中心线两侧 1σ 区之内', points: '15 点', source: 'Nelson 1984 / Minitab 检验 7' },
  8: { name: '准则 8', def: '连续 8 点全部落在 1σ 区之外(两侧皆可)', points: '8 点', source: 'Nelson 1984 / Minitab 检验 8' },
} as const;

const onlyRule = (rule: RuleNo): NelsonRules => ({
  r1: rule === 1,
  r2: rule === 2,
  r3: rule === 3,
  r4: rule === 4,
  r5: rule === 5,
  r6: rule === 6,
  r7: rule === 7,
  r8: rule === 8,
});

describe('RULE_DEFS', () => {
  it('八条准则的中文定义、点数、σ 区域与同侧语义符合独立黄金值', () => {
    expect(RULE_DEFS).toEqual(GOLDEN_RULE_DEFS);
  });

  it.each([
    { rule: 1 as const, data: [3.1], hitIndexes: [0] },
    { rule: 2 as const, data: Array(9).fill(0.5), hitIndexes: [8] },
    { rule: 3 as const, data: [0, 1, 2, 3, 4, 5], hitIndexes: [5] },
    { rule: 4 as const, data: [1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1], hitIndexes: [13] },
    { rule: 5 as const, data: [2.1, 2.2, 0], hitIndexes: [0, 1] },
    { rule: 6 as const, data: [1.1, 1.2, 1.3, 1.4, 0], hitIndexes: [0, 1, 2, 3] },
    { rule: 7 as const, data: Array(15).fill(0.5), hitIndexes: [14] },
    { rule: 8 as const, data: [1.1, -1.1, 1.1, -1.1, 1.1, -1.1, 1.1, -1.1], hitIndexes: [7] },
  ])('准则 $rule 命中时返回独立黄金描述', ({ rule, data, hitIndexes }) => {
    const { list } = evalRules(data, 0, 1, onlyRule(rule));
    expect(list).toEqual(hitIndexes.map((i) => ({
      i,
      rule,
      desc: GOLDEN_RULE_DEFS[rule].def,
    })));
  });

  it('1σ/2σ/3σ 边界等于阈值时不算“之外”', () => {
    expect(evalRules([3], 0, 1, onlyRule(1)).list).toHaveLength(0);
    expect(evalRules([3.001], 0, 1, onlyRule(1)).list.some((x) => x.rule === 1)).toBe(true);
    expect(evalRules([2, 2, 0], 0, 1, onlyRule(5)).list).toHaveLength(0);
    expect(evalRules([2.001, 2.001, 0], 0, 1, onlyRule(5)).list.some((x) => x.rule === 5)).toBe(true);
    expect(evalRules([1, 1, 1, 1, 0], 0, 1, onlyRule(6)).list).toHaveLength(0);
    expect(evalRules([1.001, 1.001, 1.001, 1.001, 0], 0, 1, onlyRule(6)).list.some((x) => x.rule === 6)).toBe(true);
    expect(evalRules(Array(15).fill(1), 0, 1, onlyRule(7)).list).toHaveLength(0);
    expect(evalRules(Array(8).fill(1), 0, 1, onlyRule(8)).list).toHaveLength(0);
  });
});
