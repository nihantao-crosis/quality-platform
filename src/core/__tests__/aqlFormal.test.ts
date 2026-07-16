/** GB/T 2828.1-2012 / ISO 2859-1:1999 正式一次抽样表逐格回归。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AQL_COLS, aqlPlanByState, masterPlanByState, normalPlanOneStepTighter,
  oneStepTighterAql, type InspectionState,
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

  expect(AQL_COLS).toEqual([0.65, 1.0, 1.5, 2.5, 4.0, 6.5]);
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

  it('非正式 AQL 不得静默回落二项近似', () => {
    expect(masterPlanByState('normal', 'F', 10)).toBeNull();
    expect(() => aqlPlanByState(120, 'II', 10, 'normal')).toThrow(/不支持/);
  });

  it('表 2-C 使用独立样本量序列，并保留箭头解析后的执行字码', () => {
    expect(masterPlanByState('reduced', 'K', 1.0)).toEqual({ code: 'K', n: 50, ac: 2, re: 3 });
    expect(masterPlanByState('reduced', 'M', 6.5)).toEqual({ code: 'L', n: 80, ac: 10, re: 11 });
  });
});

describe('转移得分的严一档 AQL', () => {
  it('六个产品 AQL 的严一档映射完整，0.65 使用正式 0.40 列', () => {
    expect(AQL_COLS.map(oneStepTighterAql)).toEqual([0.4, 0.65, 1.0, 1.5, 2.5, 4.0]);
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
