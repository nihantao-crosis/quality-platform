/** GB/T 2828.1-2012 / ISO 2859-1:1999 正式一次抽样表逐格回归。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AQL_COLS, aqlPlanByState, masterPlanByState, normalPlanOneStepTighter,
  oneStepTighterAql, CODE_LETTER_TABLE, codeLetterGB, type InspectionState,
} from '../aql';
import { buildAqlReportData, freshSwitchStatus, recordInspection } from '../aqlSwitch';

const PDF_SHA256 = '7a336944db23d14cf23fe007b0cfe2dffa5d5bef434767d2b1300ffaa35e5a37';
const TABLE_AQLS = ['0.65', '1.0', '1.5', '2.5', '4.0', '6.5'] as const;
const INITIAL_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R'];

interface FixtureFile {
  metadata: string[];
  rows: Record<string, string>[];
}

interface GoldenPlan {
  code: string;
  n: number;
  ac: number;
  re: number;
}

function loadTsv(name: string): FixtureFile {
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

function parsePlan(cell: string, context: string): GoldenPlan {
  const parts = cell.split('/');
  expect(parts, `夹具单元格格式错误：${context}=${cell}`).toHaveLength(4);
  const [code, nText, acText, reText] = parts;
  const plan = { code, n: Number(nText), ac: Number(acText), re: Number(reText) };
  expect(INITIAL_CODES, `${context} 含国标表中不存在的执行字码 ${plan.code}`).toContain(plan.code);
  expect([plan.n, plan.ac, plan.re], `${context} 含非数值`).toSatisfy(
    (values: number[]) => values.every(Number.isInteger),
  );
  expect(plan.re, `${context} 的 Re 必须在夹具内显式给出`).toBe(plan.ac + 1);
  return plan;
}

describe('正式表黄金夹具来源', () => {
  it('固定国标 PDF 哈希、页码及 304 个显式方案单元格', () => {
    const tables = loadTsv('gbt2828-1-2012-tables-2abc.tsv');
    const col040 = loadTsv('gbt2828-1-2012-table-2a-aql-0.40.tsv');

    expect(tables.metadata).toContain(`# pdf_sha256=${PDF_SHA256}`);
    expect(col040.metadata).toContain(`# pdf_sha256=${PDF_SHA256}`);
    expect(tables.rows).toHaveLength(48);
    expect(col040.rows).toHaveLength(16);
    for (const row of col040.rows) {
      expect(row).toMatchObject({
        source_table: '2-A', pdf_page: '21', printed_page: '15', aql: '0.40',
      });
    }
    expect(col040.rows.map((row) => row.initial_code)).toEqual(INITIAL_CODES);

    const expectedPages = {
      normal: { source_table: '2-A', pdf_page: '21', printed_page: '15' },
      tightened: { source_table: '2-B', pdf_page: '22', printed_page: '16' },
      reduced: { source_table: '2-C', pdf_page: '23', printed_page: '17' },
    } as const;
    for (const [state, page] of Object.entries(expectedPages)) {
      const rows = tables.rows.filter((row) => row.state === state);
      expect(rows).toHaveLength(16);
      expect(rows.map((row) => row.initial_code)).toEqual(INITIAL_CODES);
      for (const row of rows) expect(row).toMatchObject(page);
    }

    let explicitCells = 0;
    for (const row of tables.rows) {
      for (const aql of TABLE_AQLS) {
        parsePlan(row[`aql_${aql}`], `${row.source_table}/${row.initial_code}/AQL${aql}`);
        explicitCells += 1;
      }
    }
    for (const row of col040.rows) {
      parsePlan(row.plan, `2-A/${row.initial_code}/AQL0.40`);
      explicitCells += 1;
    }
    expect(explicitCells).toBe(304);
  });
});

describe('正式表 2-A / 2-B / 2-C 逐格核对', () => {
  const fixture = loadTsv('gbt2828-1-2012-tables-2abc.tsv');

  // K2:AQL_COLS 扩为 26 档;前 16 档(百分不合格品)顺序与数值不变,后 10 档为每百单位不合格数体系。
  expect(AQL_COLS).toEqual([0.01, 0.015, 0.025, 0.04, 0.065, 0.1, 0.15, 0.25, 0.4, 0.65, 1.0, 1.5, 2.5, 4.0, 6.5, 10, 15, 25, 40, 65, 100, 150, 250, 400, 650, 1000]);
  for (const state of ['normal', 'tightened', 'reduced'] as InspectionState[]) {
    it(`${state}: 16 个初始字码 × 6 个 AQL 全部一致`, () => {
      const rows = fixture.rows.filter((row) => row.state === state);
      expect(rows).toHaveLength(16);
      for (const row of rows) {
        TABLE_AQLS.forEach((aqlText) => {
          const context = `${row.source_table}/${row.initial_code}/AQL${aqlText}`;
          const expected = parsePlan(row[`aql_${aqlText}`], context);
          expect(masterPlanByState(state, row.initial_code, Number(aqlText)), context).toEqual(expected);
        });
      }
    });
  }

  it('非正式 AQL(非 26 档之一)不得静默回落二项近似;15 档 K2 起属正式主表', () => {
    // 17 不是国标档位:正式路径必须显式报错,绝不静默近似
    expect(masterPlanByState('normal', 'F', 17)).toBeNull();
    expect(() => aqlPlanByState(120, 'II', 17, 'normal')).toThrow(/不支持/);
    // K2:AQL 15(每百单位不合格数体系)已由正式主表覆盖
    expect(masterPlanByState('normal', 'F', 15)).toEqual({ code: 'F', n: 20, ac: 7, re: 8 });
    expect(aqlPlanByState(120, 'II', 15, 'normal')).toEqual({ code: 'F', n: 20, ac: 7, re: 8 });
  });

  it('表 2-C 使用独立样本量序列，并保留箭头解析后的执行字码', () => {
    expect(masterPlanByState('reduced', 'K', 1.0)).toEqual({ code: 'K', n: 50, ac: 2, re: 3 });
    expect(masterPlanByState('reduced', 'M', 6.5)).toEqual({ code: 'L', n: 80, ac: 10, re: 11 });
  });
});

describe('转移得分的严一档 AQL', () => {
  it('六个产品 AQL 的严一档映射完整，0.65 使用正式 0.40 列', () => {
    // K2:26 档的严一档 = 左邻一列;AQL 15 的严一档是 10(跨每百单位/百分体系边界,见 aql.ts 注释)。
    expect(AQL_COLS.map(oneStepTighterAql)).toEqual([null, 0.01, 0.015, 0.025, 0.04, 0.065, 0.1, 0.15, 0.25, 0.4, 0.65, 1.0, 1.5, 2.5, 4.0, 6.5, 10, 15, 25, 40, 65, 100, 150, 250, 400, 650]);
    const fixture = loadTsv('gbt2828-1-2012-table-2a-aql-0.40.tsv');
    for (const row of fixture.rows) {
      const context = `2-A/${row.initial_code}/AQL0.40`;
      expect(normalPlanOneStepTighter(row.initial_code, 0.65), context).toEqual(
        parsePlan(row.plan, context),
      );
    }
    expect(normalPlanOneStepTighter('K', 1.0)).toEqual({ code: 'K', n: 125, ac: 2, re: 3 });
  });
});

describe('AQL 结构化报告数据', () => {
  it('包含标准、来源表、方案、批判定及责任追溯字段', () => {
    const status = recordInspection(freshSwitchStatus(), {
      lot: 2000, level: 'II', aql: 1.0, nonconforming: 4,
      batchId: 'LOT-001', inspector: '张检', inspectedAt: '2026-07-14T08:00:00.000Z',
    });
    const report = buildAqlReportData(2000, 'II', 1.0, status);
    expect(report).toMatchObject({
      standard: 'GB/T 2828.1-2012 / ISO 2859-1:1999',
      samplingType: '一次抽样',
      sourceTable: '2-A',
      initialCode: 'K',
      plan: { code: 'K', n: 125, ac: 3, re: 4 },
      latestRecord: {
        batchId: 'LOT-001', inspector: '张检', nonconforming: 4,
        decision: 'rejected', sourceTable: '2-A', initialCode: 'K', finalCode: 'K',
      },
    });
    expect(report.records).toHaveLength(1);
  });

  it('全检时报告明确标记 fullInspect，不伪造抽样风险值', () => {
    const oldStatus = recordInspection(freshSwitchStatus(), {
      lot: 2000, level: 'II', aql: 1.0, nonconforming: 0,
      batchId: 'OLD-PLAN', inspector: '张检', inspectedAt: '2026-07-14T08:00:00.000Z',
    });
    const report = buildAqlReportData(8, 'II', 0.65, oldStatus);
    expect(report.plan).toMatchObject({ n: 8, fullInspect: true });
    expect(report.producerRiskPct).toBeNull();
    expect(report.rqlPct).toBeNull();
    expect(report.records).toHaveLength(1); // 旧记录仍保留供长期追溯
    expect(report.latestRecord).toBeNull(); // 但不冒充当前 N=8/AQL0.65 的批结果
  });
});


// ---------------- 全 16 档(0.010–10)扩展:夹具驱动逐格核对 ----------------
const FULL_AQLS = ['0.010', '0.015', '0.025', '0.040', '0.065', '0.10', '0.15', '0.25', '0.40', '0.65', '1.0', '1.5', '2.5', '4.0', '6.5', '10'] as const;
const FULL_AQL_NUM: Record<string, number> = {
  '0.010': 0.01, '0.015': 0.015, '0.025': 0.025, '0.040': 0.04, '0.065': 0.065, '0.10': 0.1,
  '0.15': 0.15, '0.25': 0.25, '0.40': 0.4, '0.65': 0.65, '1.0': 1.0, '1.5': 1.5, '2.5': 2.5, '4.0': 4.0, '6.5': 6.5, '10': 10,
};

describe('正式表全 16 档(0.010–10)· full16 夹具逐格核对', () => {
  const fixture = loadTsv('gbt2828-1-2012-tables-2abc-full16.tsv');

  it('夹具锁定国标 PDF 与工厂修订 xlsx 双 SHA,行数 49(2-A/2-C 各 16 行 + 2-B 17 行含 S)', () => {
    expect(fixture.metadata.join('\n')).toContain(`pdf_sha256=${PDF_SHA256}`);
    expect(fixture.metadata.join('\n')).toContain('transcription_sha256=');
    expect(fixture.rows).toHaveLength(49);
    expect(fixture.rows.filter((r) => r.state === 'tightened').map((r) => r.initial_code)).toEqual([...INITIAL_CODES, 'S']);
  });

  for (const state of ['normal', 'tightened', 'reduced'] as InspectionState[]) {
    it(`${state}: 全部字码 × 16 档逐格一致(含"-"=国标留白 → null)`, () => {
      for (const row of fixture.rows.filter((r) => r.state === state)) {
        for (const aqlText of FULL_AQLS) {
          const cell = row[`aql_${aqlText}`];
          const context = `${row.source_table}/${row.initial_code}/AQL${aqlText}`;
          const actual = masterPlanByState(state, row.initial_code, FULL_AQL_NUM[aqlText]);
          if (cell === '-') {
            expect(actual, context + ' 应为国标留白').toBeNull();
          } else {
            const parts = cell.split('/');
            expect(actual, context).toEqual({ code: parts[0], n: Number(parts[1]), ac: Number(parts[2]), re: Number(parts[3]) });
          }
        }
      }
    });
  }

  it('血统连续性:full16 的 6 个共有档与既有五重互证夹具逐格相同', () => {
    const legacy = loadTsv('gbt2828-1-2012-tables-2abc.tsv');
    for (const row of legacy.rows) {
      const full = fixture.rows.find((r) => r.state === row.state && r.initial_code === row.initial_code)!;
      for (const a of TABLE_AQLS) expect(full[`aql_${a}`], `${row.state}/${row.initial_code}/${a}`).toBe(row[`aql_${a}`]);
    }
  });

  it('工厂 xlsx 勘误已按国标修正:2-C Q/0.025 = ↑ → N/200/0/1;2-B S 行仅 0.025 有方案', () => {
    expect(masterPlanByState('reduced', 'Q', 0.025)).toEqual({ code: 'N', n: 200, ac: 0, re: 1 });
    expect(masterPlanByState('tightened', 'S', 0.025)).toEqual({ code: 'S', n: 3150, ac: 1, re: 2 });
    for (const a of AQL_COLS) if (a !== 0.025) expect(masterPlanByState('tightened', 'S', a)).toBeNull();
  });

  it('加严 Q/R 在 0.025 经 ↓ 落入 S/3150(表 2-B 的 S 行唯一入口)', () => {
    expect(masterPlanByState('tightened', 'Q', 0.025)).toEqual({ code: 'S', n: 3150, ac: 1, re: 2 });
    expect(masterPlanByState('tightened', 'R', 0.025)).toEqual({ code: 'S', n: 3150, ac: 1, re: 2 });
  });

  it('最严档 0.010 无严一档;该列 Ac≥2 方案不存在(转移得分只走 +2 分支的前提)', () => {
    expect(oneStepTighterAql(0.01)).toBeNull();
    for (const code of INITIAL_CODES) {
      const plan = masterPlanByState('normal', code, 0.01);
      expect(plan, `2-A/${code}/0.010`).not.toBeNull();
      expect(plan!.ac, `2-A/${code}/0.010 Ac`).toBeLessThanOrEqual(1);
    }
  });
});

describe('表 1 特殊检验水平 S-1~S-4 · 夹具核对', () => {
  it('table1-levels 夹具 15 行,与 CODE_LETTER_TABLE 全部 7 个水平逐格一致', () => {
    const t1 = loadTsv('gbt2828-1-2012-table1-levels.tsv');
    expect(t1.rows).toHaveLength(15);
    t1.rows.forEach((row, i) => {
      const entry = CODE_LETTER_TABLE[i];
      expect(entry['S-1'], row.lot_range).toBe(row.s1);
      expect(entry['S-2'], row.lot_range).toBe(row.s2);
      expect(entry['S-3'], row.lot_range).toBe(row.s3);
      expect(entry['S-4'], row.lot_range).toBe(row.s4);
      expect(entry.I, row.lot_range).toBe(row.I);
      expect(entry.II, row.lot_range).toBe(row.II);
      expect(entry.III, row.lot_range).toBe(row.III);
    });
  });

  it('特殊水平走完整方案链:N=1000/S-3/AQL 1.0 → 字码 E → 表 2-A E/13/0/1', () => {
    expect(codeLetterGB(1000, 'S-3')).toBe('E');
    expect(masterPlanByState('normal', codeLetterGB(1000, 'S-3'), 1.0)).toEqual({ code: 'E', n: 13, ac: 0, re: 1 });
  });
});
