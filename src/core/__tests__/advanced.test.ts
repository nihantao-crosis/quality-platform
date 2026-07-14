/**
 * 第二批引擎对拍 — 计数图 / 正态性 / Box-Cox / EWMA / CUSUM / AQL 转移 / Cpm / 文本列解析。
 */
import { describe, it, expect } from 'vitest';
import { computePChart, computeCChart } from '../attr';
import { andersonDarling, probPlotPoints } from '../normality';
import { bestLambda, boxCoxTransform, transformWithSpec } from '../boxcox';
import { ewmaSeries, cusumSeries } from '../advancedSpc';
import {
  freshSwitchStatus, plansByState, recordInspection, resumeTightenedInspection,
  setSwitchConditions, type RecordInspectionInput, type SwitchStatus,
} from '../aqlSwitch';
import { computeCapability } from '../capability';
import { parseMatrix } from '../csv';
import { buildData } from '../sampleData';

describe('计数控制图', () => {
  it('P 图公式：p̄ ± 3√(p̄(1−p̄)/n)', () => {
    const m = computePChart([2, 3, 1, 4, 2], 50, 't');
    expect(m.pbar).toBeCloseTo(12 / 250, 10);
    const sig = Math.sqrt((m.pbar * (1 - m.pbar)) / 50);
    expect(m.pUcl).toBeCloseTo(m.pbar + 3 * sig, 10);
    expect(m.pLcl).toBe(0); // 截 0
  });
  it('C 图公式：c̄ ± 3√c̄', () => {
    const m = computeCChart([4, 6, 3, 5, 7], 't');
    expect(m.cbar).toBe(5);
    expect(m.cUcl).toBeCloseTo(5 + 3 * Math.sqrt(5), 10);
  });
  it('校验：不良数不能超样本量 / 必须为整数', () => {
    expect(() => computePChart([60], 50, 't')).toThrow();
    expect(() => computeCChart([1.5, 2], 't')).toThrow();
  });
});

describe('正态性检验 (Anderson-Darling)', () => {
  it('演示数据（正态生成）应通过检验', () => {
    const D = buildData();
    const r = andersonDarling(D.all);
    expect(r.normal).toBe(true);
    expect(r.p).toBeGreaterThan(0.05);
  });
  it('强偏态数据（指数分布）应被拒绝', () => {
    let s = 42;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const exp = Array.from({ length: 100 }, () => -Math.log(1 - rnd()));
    const r = andersonDarling(exp);
    expect(r.normal).toBe(false);
    expect(r.p).toBeLessThan(0.05);
  });
  it('概率图坐标按值排序且 z 单调', () => {
    const pts = probPlotPoints([3, 1, 2, 5, 4, 6, 8, 7]);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].x).toBeGreaterThanOrEqual(pts[i - 1].x);
      expect(pts[i].z).toBeGreaterThan(pts[i - 1].z);
    }
  });
});

describe('Box-Cox', () => {
  it('λ=0 即对数变换；对数正态数据最优 λ 接近 0', () => {
    expect(boxCoxTransform(Math.E, 0)).toBeCloseTo(1, 10);
    let s = 7;
    const rnd = () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
    const rn = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const lognormal = Array.from({ length: 200 }, () => Math.exp(1 + 0.5 * rn()));
    const r = bestLambda(lognormal);
    if ('error' in r) throw new Error(r.error);
    expect(Math.abs(r.lambda)).toBeLessThanOrEqual(0.3);
  });
  it('负数据拒绝；λ<0 时规格限交换后仍 lsl<usl', () => {
    expect('error' in bestLambda([1, -2, 3])).toBe(true);
    const t = transformWithSpec([1, 2, 3], 0.5, 4, -1);
    if ('error' in t) throw new Error(t.error);
    expect(t.lsl).toBeLessThan(t.usl);
  });
});

describe('EWMA / CUSUM', () => {
  it('EWMA 递推与限值单调放宽至渐近', () => {
    const r = ewmaSeries([1, 2, 3], 0, 1, 0.5, 3);
    expect(r.z[0]).toBeCloseTo(0.5, 10); // 0.5*1+0.5*0
    expect(r.z[1]).toBeCloseTo(1.25, 10);
    expect(r.z[2]).toBeCloseTo(2.125, 10);
    expect(r.ucl[0]).toBeLessThan(r.ucl[2]);
  });
  it('稳定过程无告警；持续 1σ 漂移可检出', () => {
    let s = 99;
    const rnd = () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
    const rn = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const stable = Array.from({ length: 30 }, () => rn());
    const drifted = [...stable.slice(0, 15), ...Array.from({ length: 20 }, () => 1 + rn())];
    expect(cusumSeries(stable, 0, 1).viol.size).toBe(0);
    expect(cusumSeries(drifted, 0, 1).viol.size).toBeGreaterThan(0);
    expect(ewmaSeries(drifted, 0, 1).viol.size).toBeGreaterThan(0);
  });
});

describe('AQL 转移规则', () => {
  let batchNo = 0;
  const input = (nonconforming: number, patch: Partial<RecordInspectionInput> = {}): RecordInspectionInput => ({
    lot: 2000,
    level: 'II',
    aql: 1.0,
    nonconforming,
    batchId: `LOT-${++batchNo}`,
    inspector: '检验员A',
    inspectedAt: `2026-07-14T00:${String(batchNo).padStart(2, '0')}:00.000Z`,
    ...patch,
  });
  const run = (defects: number[], initial: SwitchStatus = freshSwitchStatus()) => (
    defects.reduce((status, d) => recordInspection(status, input(d)), initial)
  );

  it('正常 → 加严：5 批或少于 5 批初次检验中 2 批不接收', () => {
    expect(run([4, 0, 4]).state).toBe('tightened');
    expect(run([0, 0, 0, 0, 4]).state).toBe('normal');
  });

  it('加严 → 正常：连续 5 批接收', () => {
    const tightened = { ...freshSwitchStatus(), state: 'tightened' as const, note: '开始加严' };
    expect(run([0, 0, 0, 0], tightened).state).toBe('tightened');
    expect(run([0, 0, 0, 0, 0], tightened).state).toBe('normal');
  });

  it('正常 → 放宽：转移得分≥30 + 生产稳定 + 负责部门同意', () => {
    const eligible = setSwitchConditions(freshSwitchStatus(), { productionSteady: true, reducedApproved: true });
    const reduced = run(Array(10).fill(0), eligible); // K/1.0 严一档为 K/0.65/Ac2，每批 +3
    expect(reduced.state).toBe('reduced');
    expect(reduced.switchingScore).toBe(30);
    expect(recordInspection(reduced, input(2)).state).toBe('normal'); // 表 2-C:K/50/Ac1/Re2
  });

  it('转移得分：Ac≥2 需在严一档 AQL 仍接收；Ac=0/1 接收时 +2', () => {
    let status = recordInspection(freshSwitchStatus(), input(0));
    expect(status.switchingScore).toBe(3);
    status = recordInspection(status, input(3)); // 当前 Ac3 接收，但严一档 Ac2 不接收
    expect(status.switchingScore).toBe(0);

    const smallAc = recordInspection(freshSwitchStatus(), input(0, { lot: 120 }));
    expect(plansByState(120, 'II', 1.0).normal.ac).toBe(0);
    expect(smallAc.switchingScore).toBe(2);
  });

  it('复验批留痕但不计入转移；实际不合格数自动决定批结果', () => {
    const original = recordInspection(freshSwitchStatus(), input(4));
    const reinspection = recordInspection(original, input(4, { originalInspection: false }));
    expect(reinspection.history).toEqual(['R']);
    expect(reinspection.records).toHaveLength(2);
    expect(reinspection.records[1]).toMatchObject({ originalInspection: false, nonconforming: 4, result: 'R', decision: 'rejected' });
  });

  it('加严检验累计 5 批不接收时暂停，纠正确认后从加严恢复', () => {
    const tightened = { ...freshSwitchStatus(), state: 'tightened' as const, note: '开始加严' };
    const stopped = run([3, 3, 3, 3, 3], tightened); // 表 2-B:K/125/Ac2/Re3
    expect(stopped.suspended).toBe(true);
    expect(() => recordInspection(stopped, input(0))).toThrow(/暂停/);
    expect(resumeTightenedInspection(stopped)).toMatchObject({ state: 'tightened', suspended: false, tightenedRejections: 0 });
  });

  it('三态方案直接取正式表 2-A / 2-B / 2-C', () => {
    const p = plansByState(2000, 'II', 1.0);
    expect(p.normal).toMatchObject({ code: 'K', n: 125, ac: 3 });
    expect(p.tightened).toMatchObject({ code: 'K', n: 125, ac: 2, re: 3 });
    expect(p.reduced).toMatchObject({ code: 'K', n: 50, ac: 1, re: 2 });
  });

  it('三态方案 Ac=0 边界仍满足 Re=Ac+1', () => {
    const q = plansByState(120, 'II', 1.0);
    expect(q.normal).toMatchObject({ ac: 0, re: 1 });
    expect(q.tightened).toMatchObject({ code: 'F', n: 20, ac: 0, re: 1 });
    expect(q.reduced).toMatchObject({ code: 'E', n: 5, ac: 0, re: 1 });
    expect(q.reduced.re).toBe(q.reduced.ac + 1);
  });
});

describe('Cpm 望目能力', () => {
  it('过程均值 = 目标时 Cpm ≈ Cp（整体）', () => {
    const D = buildData();
    const cap = computeCapability(D.all, D.sigmaWithin, { lsl: 24.9, tgt: D.oMean, usl: 25.1 });
    const tau = Math.sqrt(D.all.reduce((a, b) => a + (b - D.oMean) ** 2, 0) / D.all.length);
    expect(cap.cpm).toBeCloseTo(0.2 / (6 * tau), 10);
  });
  it('偏离目标越远 Cpm 越小', () => {
    const D = buildData();
    const onTarget = computeCapability(D.all, D.sigmaWithin, { lsl: 24.9, tgt: D.oMean, usl: 25.1 });
    const offTarget = computeCapability(D.all, D.sigmaWithin, { lsl: 24.9, tgt: D.oMean + 0.05, usl: 25.1 });
    expect(offTarget.cpm!).toBeLessThan(onTarget.cpm!);
  });
});

describe('CSV 文本列（分组数据）', () => {
  it('保留文本列且与保留行对齐', () => {
    const r = parseMatrix('直径,设备,操作员\n25.01,A,张\n25.02,B,李\nx,B,王\n25.03,A,张\n25.04,B,李');
    if ('error' in r) throw new Error(r.error);
    expect(r.colNames).toEqual(['直径']);
    expect(r.rows.length).toBe(4);
    expect(r.textCols.map((c) => c.name)).toEqual(['设备', '操作员']);
    expect(r.textCols[0].values).toEqual(['A', 'B', 'A', 'B']); // 跳过 x 行后对齐
    expect(r.skippedRows).toBe(1);
  });
});
