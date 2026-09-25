/**
 * fix2609l · G22b-core (6):ewmaSeries 的默认 λ/L 取自 advancedSpcParams 的唯一来源(EWMA_LAMBDA/EWMA_L),
 * 不再是与之「数值恰好相同」的字面量。用 vi.mock 把常数换成别的值:修复前默认参数仍按 0.2/2.7 计算,
 * 修复后跟随唯一来源。生产常数本身(0.2/2.7)不变,另由 advanced.test 等既有用例锁定。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../advancedSpcParams', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../advancedSpcParams')>()),
  EWMA_LAMBDA: 0.3,
  EWMA_L: 3.1,
}));

import { ewmaSeries } from '../advancedSpc';

describe('(6) ewmaSeries 默认参数单一来源', () => {
  it('默认 λ/L 跟随 EWMA_LAMBDA/EWMA_L', () => {
    const data = [10.4, 9.8, 10.1, 10.6];
    const byDefault = ewmaSeries(data, 10, 0.5);
    const explicit = ewmaSeries(data, 10, 0.5, 0.3, 3.1);
    expect(byDefault.z).toEqual(explicit.z);
    expect(byDefault.ucl).toEqual(explicit.ucl);
    expect(byDefault.lcl).toEqual(explicit.lcl);
    // z1 = λx1 + (1−λ)μ0
    expect(byDefault.z[0]).toBeCloseTo(0.3 * 10.4 + 0.7 * 10, 12);
  });
});
