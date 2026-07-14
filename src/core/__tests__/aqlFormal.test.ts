/** GB/T 2828.1-2012 / ISO 2859-1:1999 正式一次抽样表逐格回归。 */
import { describe, expect, it } from 'vitest';
import {
  AQL_COLS, aqlPlanByState, masterPlanByState, normalPlanOneStepTighter,
  oneStepTighterAql, type InspectionState,
} from '../aql';
import { buildAqlReportData, freshSwitchStatus, recordInspection } from '../aqlSwitch';

/**
 * 以“最终字码 n Ac”独立声明标准期望值。每行 6 格依次为
 * AQL 0.65 / 1.0 / 1.5 / 2.5 / 4.0 / 6.5；Re 在 1999 版三张表中均为 Ac+1。
 */
const EXPECTED: Record<InspectionState, Record<string, string>> = {
  normal: {
    A: 'F 20 0|E 13 0|D 8 0|C 5 0|B 3 0|A 2 0',
    B: 'F 20 0|E 13 0|D 8 0|C 5 0|B 3 0|A 2 0',
    C: 'F 20 0|E 13 0|D 8 0|C 5 0|B 3 0|D 8 1',
    D: 'F 20 0|E 13 0|D 8 0|C 5 0|E 13 1|D 8 1',
    E: 'F 20 0|E 13 0|D 8 0|F 20 1|E 13 1|E 13 2',
    F: 'F 20 0|E 13 0|G 32 1|F 20 1|F 20 2|F 20 3',
    G: 'F 20 0|H 50 1|G 32 1|G 32 2|G 32 3|G 32 5',
    H: 'J 80 1|H 50 1|H 50 2|H 50 3|H 50 5|H 50 7',
    J: 'J 80 1|J 80 2|J 80 3|J 80 5|J 80 7|J 80 10',
    K: 'K 125 2|K 125 3|K 125 5|K 125 7|K 125 10|K 125 14',
    L: 'L 200 3|L 200 5|L 200 7|L 200 10|L 200 14|L 200 21',
    M: 'M 315 5|M 315 7|M 315 10|M 315 14|M 315 21|L 200 21',
    N: 'N 500 7|N 500 10|N 500 14|N 500 21|M 315 21|L 200 21',
    P: 'P 800 10|P 800 14|P 800 21|N 500 21|M 315 21|L 200 21',
    Q: 'Q 1250 14|Q 1250 21|P 800 21|N 500 21|M 315 21|L 200 21',
    R: 'R 2000 21|Q 1250 21|P 800 21|N 500 21|M 315 21|L 200 21',
  },
  tightened: {
    A: 'G 32 0|F 20 0|E 13 0|D 8 0|C 5 0|B 3 0',
    B: 'G 32 0|F 20 0|E 13 0|D 8 0|C 5 0|B 3 0',
    C: 'G 32 0|F 20 0|E 13 0|D 8 0|C 5 0|E 13 1',
    D: 'G 32 0|F 20 0|E 13 0|D 8 0|F 20 1|E 13 1',
    E: 'G 32 0|F 20 0|E 13 0|G 32 1|F 20 1|E 13 1',
    F: 'G 32 0|F 20 0|H 50 1|G 32 1|F 20 1|F 20 2',
    G: 'G 32 0|J 80 1|H 50 1|G 32 1|G 32 2|G 32 3',
    H: 'K 125 1|J 80 1|H 50 1|H 50 2|H 50 3|H 50 5',
    J: 'K 125 1|J 80 1|J 80 2|J 80 3|J 80 5|J 80 8',
    K: 'K 125 1|K 125 2|K 125 3|K 125 5|K 125 8|K 125 12',
    L: 'L 200 2|L 200 3|L 200 5|L 200 8|L 200 12|L 200 18',
    M: 'M 315 3|M 315 5|M 315 8|M 315 12|M 315 18|L 200 18',
    N: 'N 500 5|N 500 8|N 500 12|N 500 18|M 315 18|L 200 18',
    P: 'P 800 8|P 800 12|P 800 18|N 500 18|M 315 18|L 200 18',
    Q: 'Q 1250 12|Q 1250 18|P 800 18|N 500 18|M 315 18|L 200 18',
    R: 'R 2000 18|Q 1250 18|P 800 18|N 500 18|M 315 18|L 200 18',
  },
  reduced: {
    A: 'F 8 0|E 5 0|D 3 0|C 2 0|B 2 0|A 2 0',
    B: 'F 8 0|E 5 0|D 3 0|C 2 0|B 2 0|A 2 0',
    C: 'F 8 0|E 5 0|D 3 0|C 2 0|B 2 0|D 3 0',
    D: 'F 8 0|E 5 0|D 3 0|C 2 0|E 5 0|D 3 0',
    E: 'F 8 0|E 5 0|D 3 0|F 8 0|E 5 0|E 5 1',
    F: 'F 8 0|E 5 0|G 13 0|F 8 0|F 8 1|F 8 1',
    G: 'F 8 0|H 20 0|G 13 0|G 13 1|G 13 1|G 13 2',
    H: 'J 32 0|H 20 0|H 20 1|H 20 1|H 20 2|H 20 3',
    J: 'J 32 0|J 32 1|J 32 1|J 32 2|J 32 3|J 32 5',
    K: 'K 50 1|K 50 1|K 50 2|K 50 3|K 50 5|K 50 7',
    L: 'L 80 1|L 80 2|L 80 3|L 80 5|L 80 7|L 80 10',
    M: 'M 125 2|M 125 3|M 125 5|M 125 7|M 125 10|L 80 10',
    N: 'N 200 3|N 200 5|N 200 7|N 200 10|M 125 10|L 80 10',
    P: 'P 315 5|P 315 7|P 315 10|N 200 10|M 125 10|L 80 10',
    Q: 'Q 500 7|Q 500 10|P 315 10|N 200 10|M 125 10|L 80 10',
    R: 'R 800 10|Q 500 10|P 315 10|N 200 10|M 125 10|L 80 10',
  },
};

describe('正式表 2-A / 2-B / 2-C 逐格核对', () => {
  for (const state of ['normal', 'tightened', 'reduced'] as InspectionState[]) {
    it(`${state}: 16 个初始字码 × 6 个 AQL 全部一致`, () => {
      for (const [initialCode, row] of Object.entries(EXPECTED[state])) {
        const cells = row.split('|');
        expect(cells).toHaveLength(AQL_COLS.length);
        AQL_COLS.forEach((aql, column) => {
          const [code, nText, acText] = cells[column].split(' ');
          const ac = Number(acText);
          expect(masterPlanByState(state, initialCode, aql), `${state}/${initialCode}/AQL${aql}`).toEqual({
            code, n: Number(nText), ac, re: ac + 1,
          });
        });
      }
    });
  }

  it('非正式 AQL 不得静默回落二项近似', () => {
    expect(masterPlanByState('normal', 'F', 10)).toBeNull();
    expect(() => aqlPlanByState(120, 'II', 10, 'normal')).toThrow(/不支持/);
  });

  it('表 2-C 使用独立样本量序列，并保留箭头解析后的执行字码', () => {
    expect(masterPlanByState('reduced', 'K', 1.0)).toEqual({ code: 'K', n: 50, ac: 1, re: 2 });
    expect(masterPlanByState('reduced', 'M', 6.5)).toEqual({ code: 'L', n: 80, ac: 10, re: 11 });
  });
});

describe('转移得分的严一档 AQL', () => {
  it('六个产品 AQL 的严一档映射完整，0.65 使用正式 0.40 列', () => {
    expect(AQL_COLS.map(oneStepTighterAql)).toEqual([0.4, 0.65, 1.0, 1.5, 2.5, 4.0]);
    const expected040: Record<string, string> = {
      A: 'G 32 0', B: 'G 32 0', C: 'G 32 0', D: 'G 32 0',
      E: 'G 32 0', F: 'G 32 0', G: 'G 32 0', H: 'G 32 0',
      J: 'K 125 1', K: 'K 125 1', L: 'L 200 2', M: 'M 315 3',
      N: 'N 500 5', P: 'P 800 7', Q: 'Q 1250 10', R: 'R 2000 14',
    };
    for (const [initialCode, cell] of Object.entries(expected040)) {
      const [code, nText, acText] = cell.split(' ');
      const ac = Number(acText);
      expect(normalPlanOneStepTighter(initialCode, 0.65), `2-A/${initialCode}/AQL0.40`).toEqual({
        code, n: Number(nText), ac, re: ac + 1,
      });
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
