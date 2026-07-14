/** Nelson 准则定义表:与判异引擎文案一致、四条齐全、含来源。 */
import { describe, it, expect } from 'vitest';
import { RULE_DEFS, evalRules } from '../../core';

describe('RULE_DEFS', () => {
  it('四条准则定义齐全且含标准点数与来源', () => {
    for (const n of [1, 2, 3, 4] as const) {
      expect(RULE_DEFS[n].def.length).toBeGreaterThan(6);
      expect(RULE_DEFS[n].points).toBeTruthy();
      expect(RULE_DEFS[n].source).toContain('Nelson');
    }
  });

  it('判异命中的 desc 与定义表一致(准则 1)', () => {
    // 构造一个明显超 3σ 的点
    const data = [0, 0, 0, 0, 10];
    const { list } = evalRules(data, 0, 1, { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false });
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].desc).toBe(RULE_DEFS[1].def);
  });
});
