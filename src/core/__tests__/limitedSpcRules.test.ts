import { describe, expect, it } from 'vitest';
import { evalLimitedRules, type NelsonRules } from '../spc';
import { stagedRange } from '../stages';

const off: NelsonRules = { r1: false, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };

describe('R/S/MR/P/C 的适用准则 1–4', () => {
  it('准则 1 使用离散图实际非对称控制限', () => {
    const r = evalLimitedRules([-0.1, 5, 10.1], 5, 10, 0, { ...off, r1: true });
    expect([...r.viol]).toEqual([0, 2]);
    expect(r.list.map((x) => x.rule)).toEqual([1, 1]);
  });

  it('R/S/MR 可执行准则 2–4，而准则 5–8 即使开启也不执行', () => {
    const r2 = evalLimitedRules(Array(9).fill(6), 5, 20, 0, { ...off, r2: true });
    expect(r2.list.some((x) => x.rule === 2)).toBe(true);
    expect(r2.viol.size).toBe(9);

    const unavailable = evalLimitedRules([8, 8, 5], 5, 20, 0, { ...off, r5: true, r6: true, r7: true, r8: true });
    expect(unavailable.viol.size).toBe(0);
    expect(unavailable.list).toEqual([]);
  });

  it('分阶段 R 图也执行趋势准则，不只检查越界点', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((range) => [0, range]);
    const result = stagedRange(rows, Array(6).fill('同一阶段'), { ...off, r3: true });
    expect(result.list.some((x) => x.rule === 3)).toBe(true);
    expect([...result.viol]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

