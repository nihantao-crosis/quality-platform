/**
 * K2 批次:GB/T 2828.1 AQL 15–1000 十档「每百单位不合格数」体系(泊松,d 可大于 n)。
 *
 * 表值权威源:国标原扫描件双盲转录共识(490 格零分歧)+ 与工厂 xlsx 三方机器 diff,
 * 经箭头解析与结构不变量脚本验证后固化为黄金夹具 gbt2828-1-2012-tables-2abc-aql15-1000.tsv;
 * 本文件逐格核对代码表 vs 夹具,并锁定 16 档区共享格未被本次改动触碰。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AQL_COLS, AQL_PERCENT_COLS, AQL_PER100_COLS, PER100_MAX_D_PER_UNIT, PER100_RQL_SEARCH_MAX, aqlPlanByState, aqlRegime,
  masterPlanByState, normalPlanOneStepTighter, ocPa, oneStepTighterAql, producerRiskPct,
  rqlFor, rqlForResult, type InspectionState, type SamplingPlan,
} from '../aql';
import { poissonCdf } from '../basicMath';
import {
  buildAqlReportData, decideLot, freshSwitchStatus, maxNonconforming,
  normalizeSwitchStatus, recordInspection,
} from '../aqlSwitch';
import { projectStoreValidationError } from '../../platform/project';

const PDF_SHA256 = '7a336944db23d14cf23fe007b0cfe2dffa5d5bef434767d2b1300ffaa35e5a37';
const PER100_AQLS = ['15', '25', '40', '65', '100', '150', '250', '400', '650', '1000'] as const;
const FULL16_AQLS = ['0.010', '0.015', '0.025', '0.040', '0.065', '0.10', '0.15', '0.25', '0.40', '0.65', '1.0', '1.5', '2.5', '4.0', '6.5', '10'] as const;
const FULL16_NUM: Record<string, number> = {
  '0.010': 0.01, '0.015': 0.015, '0.025': 0.025, '0.040': 0.04, '0.065': 0.065, '0.10': 0.1,
  '0.15': 0.15, '0.25': 0.25, '0.40': 0.4, '0.65': 0.65, '1.0': 1.0, '1.5': 1.5, '2.5': 2.5, '4.0': 4.0, '6.5': 6.5, '10': 10,
};
const INITIAL_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R'];
const STATES: InspectionState[] = ['normal', 'tightened', 'reduced'];

function loadTsv(name: string) {
  const lines = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const metadata = lines.filter((line) => line.startsWith('#'));
  const data = lines.filter((line) => !line.startsWith('#'));
  const headers = data[0]?.split('\t') ?? [];
  const rows = data.slice(1).map((line) => {
    const values = line.split('\t');
    expect(values, `夹具行列数错误：${line}`).toHaveLength(headers.length);
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
  return { metadata, rows };
}

function parseCell(cell: string): SamplingPlan {
  const [code, n, ac, re] = cell.split('/');
  return { code, n: Number(n), ac: Number(ac), re: Number(re) };
}

describe('K2 黄金夹具来源与逐格核对(490 格)', () => {
  const fixture = loadTsv('gbt2828-1-2012-tables-2abc-aql15-1000.tsv');

  it('夹具锁定国标 PDF 哈希、双盲转录、三方 diff 与勘误#3;49 行 × 10 列 = 490 格', () => {
    const meta = fixture.metadata.join('\n');
    expect(meta).toContain(`pdf_sha256=${PDF_SHA256}`);
    expect(meta).toContain('双盲转录');
    expect(meta).toContain('three_way_diff');
    expect(meta).toContain('勘误#3');
    expect(fixture.rows).toHaveLength(49);
    expect(fixture.rows.filter((r) => r.state === 'tightened').map((r) => r.initial_code)).toEqual([...INITIAL_CODES, 'S']);
    let cells = 0;
    let blanks = 0;
    for (const row of fixture.rows) {
      for (const aql of PER100_AQLS) {
        const cell = row[`aql_${aql}`];
        cells += 1;
        if (cell === '-') {
          blanks += 1;
          expect(row.initial_code, '留白只允许出现在 2-B 的 S 行(勘误#3)').toBe('S');
        } else {
          const plan = parseCell(cell);
          expect(plan.re, `${row.state}/${row.initial_code}/${aql} Re 必须显式给出`).toBe(plan.ac + 1);
        }
      }
    }
    expect(cells).toBe(490);
    expect(blanks).toBe(10); // 勘误#3:2-B S 行 15–1000 全部留白
  });

  for (const state of STATES) {
    it(`${state}: 全部字码 × 10 档逐格一致(含 2-B S 行留白 → null)`, () => {
      for (const row of fixture.rows.filter((r) => r.state === state)) {
        for (const aql of PER100_AQLS) {
          const cell = row[`aql_${aql}`];
          const context = `${row.source_table}/${row.initial_code}/AQL${aql}`;
          const actual = masterPlanByState(state, row.initial_code, Number(aql));
          if (cell === '-') expect(actual, `${context} 应为国标留白`).toBeNull();
          else expect(actual, context).toEqual(parseCell(cell));
        }
      }
    });
  }

  it('16 档区共享格未被本次改动触碰:与 full16 夹具逐格重核', () => {
    const full16 = loadTsv('gbt2828-1-2012-tables-2abc-full16.tsv');
    let checked = 0;
    for (const row of full16.rows) {
      for (const aqlText of FULL16_AQLS) {
        const cell = row[`aql_${aqlText}`];
        const actual = masterPlanByState(row.state as InspectionState, row.initial_code, FULL16_NUM[aqlText]);
        if (cell === '-') expect(actual, `${row.state}/${row.initial_code}/${aqlText}`).toBeNull();
        else expect(actual, `${row.state}/${row.initial_code}/${aqlText}`).toEqual(parseCell(cell));
        checked += 1;
      }
    }
    expect(checked).toBe(49 * 16);
  });

  it('关键锚点(每表含直读/↓改档/↑改档/长箭头;n、Ac 整格一起改)', () => {
    // 表 2-A
    expect(masterPlanByState('normal', 'A', 15)).toEqual({ code: 'B', n: 3, ac: 1, re: 2 });      // ↓ 改档
    expect(masterPlanByState('normal', 'J', 15)).toEqual({ code: 'J', n: 80, ac: 21, re: 22 });   // 直读
    expect(masterPlanByState('normal', 'K', 15)).toEqual({ code: 'J', n: 80, ac: 21, re: 22 });   // ↑ 改档
    expect(masterPlanByState('normal', 'F', 100)).toEqual({ code: 'E', n: 13, ac: 21, re: 22 });  // ↑ 改档
    expect(masterPlanByState('normal', 'A', 1000)).toEqual({ code: 'A', n: 2, ac: 30, re: 31 }); // 直读,d≫n
    expect(masterPlanByState('normal', 'R', 1000)).toEqual({ code: 'B', n: 3, ac: 44, re: 45 }); // 跨 14 行长 ↑
    // 表 2-B
    expect(masterPlanByState('tightened', 'A', 15)).toEqual({ code: 'C', n: 5, ac: 1, re: 2 });   // 连续两格 ↓
    expect(masterPlanByState('tightened', 'C', 15)).toEqual({ code: 'C', n: 5, ac: 1, re: 2 });   // 直读
    expect(masterPlanByState('tightened', 'A', 25)).toEqual({ code: 'B', n: 3, ac: 1, re: 2 });   // ↓ 改档
    expect(masterPlanByState('tightened', 'K', 15)).toEqual({ code: 'J', n: 80, ac: 18, re: 19 }); // ↑ 改档
    expect(masterPlanByState('tightened', 'B', 1000)).toEqual({ code: 'B', n: 3, ac: 41, re: 42 }); // 直读
    expect(masterPlanByState('tightened', 'R', 1000)).toEqual({ code: 'B', n: 3, ac: 41, re: 42 }); // 长 ↑
    // 表 2-C(注意 2-C 字码 A/B/C 的样本量都是 2,与 2-A/2-B 不同)
    expect(masterPlanByState('reduced', 'A', 15)).toEqual({ code: 'C', n: 2, ac: 1, re: 2 });     // ↓ 改档
    expect(masterPlanByState('reduced', 'B', 25)).toEqual({ code: 'B', n: 2, ac: 1, re: 2 });     // 直读
    expect(masterPlanByState('reduced', 'G', 15)).toEqual({ code: 'G', n: 13, ac: 6, re: 7 });    // 直读
    expect(masterPlanByState('reduced', 'K', 15)).toEqual({ code: 'J', n: 32, ac: 10, re: 11 });  // ↑ 改档
    expect(masterPlanByState('reduced', 'C', 1000)).toEqual({ code: 'B', n: 2, ac: 30, re: 31 }); // ↑ 改档
    expect(masterPlanByState('reduced', 'R', 1000)).toEqual({ code: 'B', n: 2, ac: 30, re: 31 }); // 长 ↑
  });

  it('结构不变量:全 26 档行内 Ac 非降、Re=Ac+1、per100 格 Ac 覆盖到 44', () => {
    let maxAc = 0;
    for (const state of STATES) {
      const codes = state === 'tightened' ? [...INITIAL_CODES, 'S'] : INITIAL_CODES;
      for (const code of codes) {
        const acs: number[] = [];
        for (const aql of AQL_COLS) {
          const plan = masterPlanByState(state, code, aql);
          if (!plan) continue; // 2-B S 行留白
          expect(plan.re, `${state}/${code}/${aql}`).toBe(plan.ac + 1);
          acs.push(plan.ac);
          maxAc = Math.max(maxAc, plan.ac);
        }
        for (let i = 1; i < acs.length; i++) {
          expect(acs[i], `${state}/${code} 行内 Ac 在第 ${i} 列下降`).toBeGreaterThanOrEqual(acs[i - 1]);
        }
      }
    }
    expect(maxAc).toBe(44); // 2-A 的 1000 列(B/3/44)
  });

  it('勘误#3 结构锁定:per100 各列经箭头到不了 S;S/3150 只存在于 0.025 列', () => {
    for (const aqlText of PER100_AQLS) {
      const aql = Number(aqlText);
      expect(masterPlanByState('tightened', 'S', aql), `2-B S/${aqlText} 应留白`).toBeNull();
      for (const code of INITIAL_CODES) {
        const plan = masterPlanByState('tightened', code, aql);
        expect(plan, `2-B ${code}/${aqlText}`).not.toBeNull();
        expect(plan!.code, `2-B ${code}/${aqlText} 不得落入 S 行`).not.toBe('S');
      }
    }
    // 唯一入口链条仍是 0.025 列:Q/R 经 ↓ 落入 S/3150
    expect(masterPlanByState('tightened', 'Q', 0.025)).toEqual({ code: 'S', n: 3150, ac: 1, re: 2 });
    expect(masterPlanByState('tightened', 'R', 0.025)).toEqual({ code: 'S', n: 3150, ac: 1, re: 2 });
    expect(masterPlanByState('tightened', 'S', 0.025)).toEqual({ code: 'S', n: 3150, ac: 1, re: 2 });
  });
});

describe('显式质量表示与 26 档列表', () => {
  it('旧载荷维持固定分流；新 per100 允许完整 26 档', () => {
    expect(AQL_COLS).toHaveLength(26);
    expect(aqlRegime(0.01)).toBe('percent');
    expect(aqlRegime(10)).toBe('percent');
    expect(aqlRegime(15)).toBe('per100');
    expect(aqlRegime(1000)).toBe('per100');
    expect(AQL_COLS.filter((a) => aqlRegime(a) === 'percent')).toHaveLength(16);
    expect(AQL_COLS.filter((a) => aqlRegime(a) === 'per100')).toEqual([15, 25, 40, 65, 100, 150, 250, 400, 650, 1000]);
    expect(AQL_PERCENT_COLS).toEqual(AQL_COLS.slice(0, 16));
    expect(AQL_PER100_COLS).toEqual(AQL_COLS);
  });
});

describe('poissonCdf(对数空间逐项和)', () => {
  it('三个手核锚点(逐项对数和,并经正则化不完全伽马 Q(k+1,λ) 双算法交叉验证)', () => {
    // P(X≤2|λ=1) = e⁻¹·(1 + 1 + 1/2) = 2.5·e⁻¹:
    //   逐项 e⁻¹=0.3678794412、λ·e⁻¹=0.3678794412、(λ²/2!)·e⁻¹=0.1839397206,和=0.9196986029
    expect(poissonCdf(2, 1)).toBeCloseTo(0.9196986029, 9);
    expect(poissonCdf(2, 1)).toBeCloseTo(2.5 * Math.exp(-1), 12);
    // P(X≤10|λ=10):对数逐项和 = 0.5830397502(= Q(11,10),连分式独立复算一致)
    expect(poissonCdf(10, 10)).toBeCloseTo(0.5830397502, 9);
    // P(X≤21|λ=12):对数逐项和 = 0.9939348526(= Q(22,12),连分式独立复算一致)
    expect(poissonCdf(21, 12)).toBeCloseTo(0.9939348526, 9);
  });

  it('边界与数值稳定:λ≤0、k<0、大 λ 不溢出、对 k 单调', () => {
    expect(poissonCdf(0, 0)).toBe(1);
    expect(poissonCdf(5, 0)).toBe(1);
    expect(poissonCdf(-1, 3)).toBe(0);
    // λ=60 时 e^{−λ}≈8.8e-27,线性递推易失真;对数空间结果=1.41743e-5(双算法一致)
    expect(poissonCdf(30, 60)).toBeCloseTo(0.0000141743, 9);
    // λ=800:e^{−λ} 在双精度下直接下溢为 0,朴素实现会得 0/NaN;对数空间仍有限且有序
    const p700 = poissonCdf(700, 800);
    const p800 = poissonCdf(800, 800);
    const p900 = poissonCdf(900, 800);
    expect(Number.isFinite(p700) && Number.isFinite(p800) && Number.isFinite(p900)).toBe(true);
    expect(p700).toBeGreaterThan(0);
    expect(p700).toBeLessThan(p800);
    expect(p800).toBeLessThan(p900);
    expect(p900).toBeLessThanOrEqual(1);
  });
});

describe('per100 的 OC / α / RQL(泊松体系)', () => {
  const j8021 = masterPlanByState('normal', 'J', 15)!; // J/80/21/22

  it('Pa = poissonCdf(Ac, n·λ/100);λ=AQL=15 时 n·λ/100=12,复用锚点 P(X≤21|12)', () => {
    expect(j8021).toEqual({ code: 'J', n: 80, ac: 21, re: 22 });
    expect(ocPa(j8021, 15, 'per100')).toBeCloseTo(poissonCdf(21, 12), 14);
    expect(ocPa(j8021, 15, 'per100')).toBeCloseTo(0.9939348526, 9);
    // percent 路径不受体系参数影响(默认仍是二项)
    expect(ocPa(j8021, 0.05)).toBeCloseTo(ocPa(j8021, 0.05, 'percent'), 14);
  });

  it('生产方风险 α = 1 − Pa(λ=AQL):J/80/21@AQL15 ≈ 0.6065%', () => {
    expect(producerRiskPct(j8021, 15)).toBeCloseTo(0.6065, 3);
    // percent 体系口径不变:仍按 p=AQL/100 的二项计算
    expect(producerRiskPct({ code: 'K', n: 125, ac: 3, re: 4 }, 1.0))
      .toBeCloseTo((1 - ocPa({ code: 'K', n: 125, ac: 3, re: 4 }, 0.01)) * 100, 12);
  });

  it('RQL(β=10%)按 λ 域搜索:J/80/21@15 → λ≈35.2;极端方案 λ 可超 1000(d>n 合法)', () => {
    const rql = rqlForResult(j8021, 0.1, undefined, 'per100');
    expect(rql.status).toBe('found');
    if (rql.status === 'found') {
      expect(rql.p).toBeGreaterThan(35.2);
      expect(rql.p).toBeLessThan(35.3);
      expect(rql.pa).toBeLessThanOrEqual(0.1);
      expect(ocPa(j8021, rql.p, 'per100')).toBeLessThanOrEqual(0.1);
      expect(rql.searchMax).toBe(PER100_RQL_SEARCH_MAX);
    }
    expect(rqlFor(j8021, 'per100')).toBeCloseTo(rql.status === 'found' ? rql.p : Number.NaN, 9);

    // 2-A R@1000 → B/3/44:λRQL≈1793,证明搜索域必须放到 1000 以上
    const b344 = masterPlanByState('normal', 'R', 1000)!;
    const extreme = rqlForResult(b344, 0.1, undefined, 'per100');
    expect(extreme.status).toBe('found');
    if (extreme.status === 'found') {
      expect(extreme.p).toBeGreaterThan(1000);
      expect(extreme.p).toBeGreaterThan(1790);
      expect(extreme.p).toBeLessThan(1796);
    }
    // 全表最极端 A/2/30(2-A A@1000):λRQL≈1916,仍在默认搜索域内
    const a230 = masterPlanByState('normal', 'A', 1000)!;
    const worst = rqlForResult(a230, 0.1, undefined, 'per100');
    expect(worst.status).toBe('found');
    if (worst.status === 'found') {
      expect(worst.p).toBeGreaterThan(1915);
      expect(worst.p).toBeLessThan(1917);
    }
  });

  it('全检时 per100 同样返回 not-applicable,不伪造抽样 RQL', () => {
    const plan = aqlPlanByState(2, 'II', 15, 'normal'); // 查表 B/3 ≥ 批量 2 → 全检
    expect(plan.fullInspect).toBe(true);
    expect(rqlForResult(plan, 0.1, undefined, 'per100'))
      .toMatchObject({ status: 'not-applicable', reason: 'full-inspection', p: null });
  });
});

describe('per100 批判定与责任账本(d 允许大于 n)', () => {
  const j8021: SamplingPlan = { code: 'J', n: 80, ac: 21, re: 22 };

  it('decideLot:per100 上限为 n×PER100_MAX_D_PER_UNIT;percent 仍以 n 为上限', () => {
    expect(maxNonconforming(j8021, 'per100')).toBe(80 * PER100_MAX_D_PER_UNIT);
    expect(maxNonconforming(j8021, 'percent')).toBe(80);
    expect(decideLot(j8021, 85, 'per100')).toBe('rejected'); // d=85 > n=80,计点体系合法
    expect(decideLot(j8021, 21, 'per100')).toBe('accepted');
    expect(() => decideLot(j8021, 85)).toThrow(/0–80/); // percent 体系维持原上限
    expect(() => decideLot(j8021, 80 * PER100_MAX_D_PER_UNIT + 1, 'per100')).toThrow(/每百单位/);
  });

  it('recordInspection:批量 1000/II/AQL15 → J/80/21/22;d=85(>n)可记录并通过账本重放', () => {
    const status = recordInspection(freshSwitchStatus(), {
      lot: 1000, level: 'II', aql: 15, nonconforming: 85,
      batchId: 'PER100-1', inspector: '张检', inspectedAt: '2026-07-17T08:00:00.000Z',
    });
    expect(status.records[0]).toMatchObject({
      finalCode: 'J', sampleSize: 80, acceptanceNumber: 21, rejectionNumber: 22,
      nonconforming: 85, decision: 'rejected', result: 'R',
    });
    // 账本重放(normalizeAqlBatchRecord)同样按体系放宽 d≤n 校验,记录不得被误隔离
    const replayed = normalizeSwitchStatus({ ...status });
    expect(replayed.records).toHaveLength(1);
    expect(replayed.records[0].nonconforming).toBe(85);
  });

  it('percent 记录的 d>n 载荷仍被账本重放拒绝(上限放宽只对 per100 生效)', () => {
    const valid = recordInspection(freshSwitchStatus(), {
      lot: 2000, level: 'II', aql: 1.0, nonconforming: 4,
      batchId: 'PCT-1', inspector: '张检', inspectedAt: '2026-07-17T08:10:00.000Z',
    });
    const forged = { ...valid.records[0], nonconforming: 126 }; // n=125 的 percent 方案
    expect(normalizeSwitchStatus({ ...valid, records: [forged] }).records).toEqual([]);
  });

  it('低 AQL 也可显式选择 per100，且账本/报告不会与同 AQL 的 percent 混淆', () => {
    const per100 = recordInspection(freshSwitchStatus(), {
      lot: 2000, level: 'II', aql: 1.0, regime: 'per100', nonconforming: 126,
      batchId: 'POINTS-LOW-AQL', inspector: '张检', inspectedAt: '2026-07-17T08:20:00.000Z',
    });
    expect(per100.records[0]).toMatchObject({ regime: 'per100', sampleSize: 125, nonconforming: 126 });
    expect(normalizeSwitchStatus(per100).records).toHaveLength(1);
    const pointsReport = buildAqlReportData(2000, 'II', 1.0, per100, 'per100');
    expect(pointsReport.regime).toBe('per100');
    expect(pointsReport.latestRecord?.batchId).toBe('POINTS-LOW-AQL');
    expect(pointsReport.rqlPer100).toBeGreaterThan(0);
    expect(pointsReport.rqlPct).toBeNull();
    const percentReport = buildAqlReportData(2000, 'II', 1.0, per100, 'percent');
    expect(percentReport.latestRecord).toBeNull();
    expect(percentReport.rqlPct).toBeGreaterThan(0);
  });

  it('S-1～S-4 责任记录在规范化与项目校验中均完整保留', () => {
    for (const level of ['S-1', 'S-2', 'S-3', 'S-4'] as const) {
      const status = recordInspection(freshSwitchStatus(), {
        lot: 2000, level, aql: 1.0, regime: 'percent', nonconforming: 0,
        batchId: `SPECIAL-${level}`, inspector: '张检', inspectedAt: `2026-07-17T09:0${level.slice(-1)}:00.000Z`,
      });
      expect(normalizeSwitchStatus(status).records).toHaveLength(1);
      expect(projectStoreValidationError('qp-aql-state-v1', {
        aqlLot: 2000, aqlLevel: level, aqlAQL: 1.0, aqlRegime: 'percent',
        aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: status,
      })).toBeNull();
    }
  });

  it('旧责任记录缺失 regime 时按 v1.38 默认安全迁移', () => {
    const status = recordInspection(freshSwitchStatus(), {
      lot: 1000, level: 'II', aql: 15, regime: 'per100', nonconforming: 85,
      batchId: 'LEGACY-REGIME', inspector: '张检', inspectedAt: '2026-07-17T09:10:00.000Z',
    });
    const legacy = { ...status.records[0] } as Partial<(typeof status.records)[number]>;
    delete legacy.regime;
    expect(normalizeSwitchStatus({ ...status, records: [legacy as (typeof status.records)[number]] }).records[0].regime).toBe('per100');
  });

  it('转移得分跨体系口径:AQL15 的严一档是 10,J 字码两档同 n=80 可比', () => {
    expect(oneStepTighterAql(15)).toBe(10);
    expect(oneStepTighterAql(25)).toBe(15);
    expect(oneStepTighterAql(1000)).toBe(650);
    expect(normalPlanOneStepTighter('J', 15)).toEqual({ code: 'J', n: 80, ac: 14, re: 15 }); // 2-A J@10

    const base = { lot: 1000, level: 'II' as const, aql: 15, inspector: '张检' };
    // d=14 ≤ 严一档 C=14 → +3
    const plus3 = recordInspection(freshSwitchStatus(), {
      ...base, nonconforming: 14, batchId: 'SW-1', inspectedAt: '2026-07-17T09:00:00.000Z',
    });
    expect(plus3.switchingScore).toBe(3);
    // d=15:当前档接收(≤21)但严一档不能接收 → 清零
    const reset = recordInspection(plus3, {
      ...base, nonconforming: 15, batchId: 'SW-2', inspectedAt: '2026-07-17T09:10:00.000Z',
    });
    expect(reset.switchingScore).toBe(0);
    expect(reset.note).toContain('严一档');
  });

  it('buildAqlReportData:per100 报告带体系与 λ 单位 RQL,不冒充百分数', () => {
    const status = recordInspection(freshSwitchStatus(), {
      lot: 1000, level: 'II', aql: 15, nonconforming: 0,
      batchId: 'RPT-1', inspector: '张检', inspectedAt: '2026-07-17T10:00:00.000Z',
    });
    const report = buildAqlReportData(1000, 'II', 15, status);
    expect(report.regime).toBe('per100');
    expect(report.plan).toMatchObject({ code: 'J', n: 80, ac: 21, re: 22 });
    expect(report.rqlPct).toBeNull(); // 单位不同,绝不塞进百分数字段
    expect(report.rqlPer100).toBeGreaterThan(35.2);
    expect(report.rqlPer100).toBeLessThan(35.3);
    expect(report.producerRiskPct).toBeCloseTo(0.6065, 3);
    // percent 报告维持原字段口径
    const pctReport = buildAqlReportData(2000, 'II', 1.0, freshSwitchStatus());
    expect(pctReport.regime).toBe('percent');
    expect(pctReport.rqlPer100).toBeNull();
    expect(pctReport.rqlPct).toBeGreaterThan(0);
  });
});

describe('快照/qproj 的 aqlAQL 校验随 AQL_COLS 放宽到 26 档', () => {
  const aqlStatePayload = (aql: number, regime?: 'percent' | 'per100') => ({
    aqlLot: 2000, aqlLevel: 'II', aqlAQL: aql, ...(regime ? { aqlRegime: regime } : {}), aqlMethod: 'gb', aqlAcMethod: 'gb',
    aqlSwitch: freshSwitchStatus(),
  });

  it('qp-aql-state-v1:aqlAQL=650 通过;17(非档位)拒绝', () => {
    expect(projectStoreValidationError('qp-aql-state-v1', aqlStatePayload(650))).toBeNull();
    expect(projectStoreValidationError('qp-aql-state-v1', aqlStatePayload(17))).toMatch(/AQL 值不在正式主表范围/);
  });

  it('显式质量表示校验：per100/AQL1 合法，percent/AQL15 拒绝；缺失字段兼容旧项目', () => {
    expect(projectStoreValidationError('qp-aql-state-v1', aqlStatePayload(1, 'per100'))).toBeNull();
    expect(projectStoreValidationError('qp-aql-state-v1', aqlStatePayload(15, 'percent'))).toMatch(/不能超过 10/);
    expect(projectStoreValidationError('qp-aql-state-v1', aqlStatePayload(15))).toBeNull();
  });

  it('qp-prefs-v1:state.aqlAQL=650 通过;17 拒绝', () => {
    expect(projectStoreValidationError('qp-prefs-v1', { version: 3, state: { aqlAQL: 650 } })).toBeNull();
    expect(projectStoreValidationError('qp-prefs-v1', { version: 3, state: { aqlAQL: 17 } })).toMatch(/AQL 值不在正式主表范围/);
  });

  it('含 per100 责任账本(d>n)的 qproj 载荷通过校验', () => {
    const status = recordInspection(freshSwitchStatus(), {
      lot: 1000, level: 'II', aql: 15, nonconforming: 85,
      batchId: 'QPROJ-1', inspector: '张检', inspectedAt: '2026-07-17T11:00:00.000Z',
    });
    expect(projectStoreValidationError('qp-aql-state-v1', {
      aqlLot: 1000, aqlLevel: 'II', aqlAQL: 15, aqlRegime: 'per100', aqlMethod: 'gb', aqlAcMethod: 'gb',
      aqlSwitch: status,
    })).toBeNull();
  });
});
