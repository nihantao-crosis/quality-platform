/** 外部黄金基准(v1.43.0 双审整改:此前 PPM 三行/pooled σ̂/描述统计 CI 只有自我实现
 * 或零数值断言,公式改错测试仍全绿)。期望值全部来自教科书常数/手算,不引用被测实现。 */
import { describe, it, expect } from 'vitest';
import { computeCapability, computeVarModel, withSigmaMethod, computeDescriptive } from '../index';

describe('PPM 三行与 Z.bench(教科书正态尾概率锚点)', () => {
  // vals=[9,11]:μ=10 精确、σ整体=√2;sigmaWithin 显式传 1 → (USL−μ)/σw = 2 精确
  const cap = computeCapability([9, 11], 1, { lsl: 8, tgt: 10, usl: 12 });

  it('组内 PPM:z=±2,单侧尾 0.0227501×1e6(A&S 表值)', () => {
    expect(cap.ppm.within.aboveUsl!).toBeCloseTo(22750.13, 0);
    expect(cap.ppm.within.belowLsl!).toBeCloseTo(22750.13, 0);
    expect(cap.ppm.within.total).toBeCloseTo(45500.26, 0);
  });

  it('整体 PPM:z=±√2,尾概率 (1−erf(1))/2=0.0786496(erf(1)=0.8427008)', () => {
    expect(cap.ppm.overall.total).toBeCloseTo(157299.2, 0);
  });

  it('实测 PPM:样本内无超差 → 0;Z.bench=Φ⁻¹(0.8427008)≈1.00563', () => {
    expect(cap.ppm.observed).toBe(0);
    expect(cap.zBench).toBeCloseTo(1.00563, 3);
    expect(cap.sigmaLevel).toBeCloseTo(2.50563, 3);
  });

  it('指标锚点:Cp=2/3、Cpk=2/3、Pp=4/(6√2)=0.4714、Cpm(对中)=Pp 同分母口径', () => {
    expect(cap.cp!).toBeCloseTo(2 / 3, 10);
    expect(cap.cpk).toBeCloseTo(2 / 3, 10);
    expect(cap.pp!).toBeCloseTo(4 / (6 * Math.SQRT2), 10);
    // τ(around T=10, /n)=1 精确 → Cpm = min(2,2)/3 = 2/3
    expect(cap.cpm!).toBeCloseTo(2 / 3, 10);
  });
});

describe('pooled σ̂ 锚点(手算 Sp/c4)', () => {
  it('两子组 s₁=s₂=1 → Sp=1,d=Σ(nᵢ−1)=4,c4(5)=0.9399856,σ̂=1.063847', () => {
    const M = computeVarModel('pooled.csv', ['a', 'b', 'c'], [[1, 2, 3], [4, 5, 6]]);
    const SM = withSigmaMethod(M, 'pooled');
    // X̄ 图限值 = X̄̄ ± 3σ̂/√n → 由限值反解 σ̂,不引用内部 σ 字段
    const sigmaHat = (SM.uclX - SM.xbarbar) * Math.sqrt(3) / 3;
    expect(sigmaHat).toBeCloseTo(1 / 0.9399856, 4);
  });
});

describe('描述统计 CI/矩(1..10 手算锚点)', () => {
  const d = computeDescriptive([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  // fix2609 TESTS-03:以下锚点按闭式精算(9 自由度为奇数,t/χ² 分布函数有 erf/三角闭式,
  // 二分求分位到双精度极限),不再用 3 位小数表值凑数;容差收紧到 toBeCloseTo(…,6)=5e-7,
  // 3 位小数查表 χ²(19.023/2.700)给出的 [2.0825118, 5.5277080] 必须被拦下。
  it('均值 95% CI = 5.5 ± t(.975,9)·s/√10 = [3.3341494, 7.6658506](t=2.2621571628)', () => {
    expect(d.ciMean[0]).toBeCloseTo(3.3341494, 6);
    expect(d.ciMean[1]).toBeCloseTo(7.6658506, 6);
  });

  it('标准差 95% CI = s·√(9/χ²) → [2.0825245, 5.5273093](χ².975=19.0227678, χ².025=2.7003895, s=3.0276504)', () => {
    expect(d.ciStdev[0]).toBeCloseTo(2.0825245, 6);
    expect(d.ciStdev[1]).toBeCloseTo(5.5273093, 6);
    // 鉴别力自检:同一 s 配 3 位小数表值 χ² 的低精度实现,在这组锚点/容差下必须转红
    // (旧锚点 5.52771 正是按 χ²=2.700 算出,旧容差 5e-4 让它与精确实现同时通过)。
    const s = Math.sqrt(165 / 18);
    expect(s * Math.sqrt(9 / 19.023)).not.toBeCloseTo(2.0825245, 6);
    expect(s * Math.sqrt(9 / 2.7)).not.toBeCloseTo(5.5273093, 6);
  });

  it('中位数 ≥95% CI:二项精确秩 l=2 → [x(2), x(9)] = [2, 9](覆盖 97.85%)', () => {
    expect(d.ciMedian).toEqual([2, 9]);
  });

  it('偏度=0(对称);超额峰度精确 −1.2(离散均匀 b2=1.775757…经小样本校正)', () => {
    expect(Math.abs(d.skewness)).toBeLessThan(1e-9);
    expect(d.kurtosis).toBeCloseTo(-1.2, 9);
  });

  it('总和 = 55 精确(stableSum 与均值同源)', () => {
    expect(d.sum).toBe(55);
  });
});
