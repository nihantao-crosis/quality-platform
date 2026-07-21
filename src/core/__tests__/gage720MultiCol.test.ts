/**
 * 批次720-B：MSA 多测量列工作表（工厂 5 列形态：部件/测试人/螺钉高度/平衡量值/电阻值）。
 *
 * 1. 推荐回落 bug（720 实锤）：多测量列并列时生效测量列绝不能落在「部件」上；
 * 2. 多列工作表路径的三套 GRR 与逐案例直连路径逐位一致（后者已被 gageFactory 黄金锁定 vs Minitab）。
 * 数据源 = 工厂 5 案例夹具（case1=螺钉高度、case2=平衡量值、case3=电阻值——工厂 5 列表即三个单人案例的合并形态；
 * 单人退化模型不使用操作员标签，故统一标注「邹德玉」不影响任何数值）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeVarModel, computeGageRR, prepareGageStudy, recommendGageRoles, effectiveGageSelection, type GageObservation } from '..';

function loadCases(): Map<string, { part: string; operator: string; value: number }[]> {
  const url = new URL('./fixtures/gage-factory-cases-2026-07.tsv', import.meta.url);
  const lines = readFileSync(fileURLToPath(url), 'utf8').trim().split('\n').slice(1);
  const map = new Map<string, { part: string; operator: string; value: number }[]>();
  for (const line of lines) {
    const [caseId, part, operator, value] = line.split('\t');
    if (!map.has(caseId)) map.set(caseId, []);
    map.get(caseId)!.push({ part, operator, value: Number(value) });
  }
  return map;
}

const cases = loadCases();
const case1 = cases.get('1')!;
const case2 = cases.get('2')!;
const case3 = cases.get('3')!;

// 工厂 5 列工作表：行序 = case1 的行序（三个案例的部件序一致，阶段0已核对首行值吻合截图）
const MULTI_COLS = ['部件', '螺钉高度', '平衡量值', '电阻值'];
const rows = case1.map((row, i) => [Number(row.part), row.value, case2[i].value, case3[i].value]);
const textCols = [{ name: '测试人', values: case1.map(() => '邹德玉') }];
const model = computeVarModel('工厂多列工作表', MULTI_COLS, rows);

describe('720-B1 多测量列推荐与生效角色', () => {
  it('多响应并列时保持待选择；部件/操作员正确，显式选择后可运行', () => {
    const eff = effectiveGageSelection(model, textCols, { value: null, part: null, operator: null });
    expect(eff.valueColumn).toBeNull();
    expect(eff.partColumn).toBe('部件');
    expect(eff.operatorColumn).toBe('测试人');
    const waiting = prepareGageStudy(model, textCols, { valueColumn: null, partColumn: eff.partColumn, operatorColumn: eff.operatorColumn });
    expect(waiting.ok).toBe(false);
    if (!waiting.ok) {
      expect(waiting.reason).toContain('请选择测量列');
      expect(waiting.reason).toContain('多个有效测量候选并列');
      expect(waiting.reason).not.toContain('均呈小整数');
    }
    for (const valueColumn of ['螺钉高度', '平衡量值', '电阻值']) {
      expect(prepareGageStudy(model, textCols, {
        valueColumn, partColumn: eff.partColumn, operatorColumn: eff.operatorColumn,
      }).ok).toBe(true);
    }
  });

  it('构造并列场景：value/valueFallback 均不猜，禁止取第一个测量列', () => {
    // 两条同形态测量列 + 一条部件 ID 列；测量打分并列时必须由用户选择。
    const tieRows = [[1, 1.15, 2.15], [2, 1.32, 2.32], [3, 1.58, 2.58], [1, 1.71, 2.71], [2, 1.94, 2.94], [3, 1.27, 2.27]];
    const tieModel = computeVarModel('并列.csv', ['部件', 'X1', 'X2'], tieRows);
    const rec = recommendGageRoles(tieModel, []);
    expect(rec.value).toBeNull();
    expect(rec.valueFallback).toBeNull();
    expect(rec.reasons.join('')).toContain('多个有效测量候选并列');
    const eff = effectiveGageSelection(tieModel, [], { value: null, part: null, operator: null });
    expect(eff.valueColumn).toBeNull();
  });

  it('全部数值列都呈小整数/类别 ID 形态时保持未选，不静默回落第一列', () => {
    const idRows: number[][] = [];
    for (const operator of [1, 2]) {
      for (const part of [1, 2, 3]) {
        for (let trial = 0; trial < 2; trial++) idRows.push([part, operator, 10 + part]);
      }
    }
    const idModel = computeVarModel('全ID列.csv', ['部件ID', '操作员ID', '批次ID'], idRows);
    const rec = recommendGageRoles(idModel, []);
    expect(rec.value).toBeNull();
    expect(rec.valueFallback).toBeNull();
    expect(rec.reasons.join('')).toContain('请手动选择');

    const eff = effectiveGageSelection(idModel, [], { value: null, part: null, operator: null });
    expect(eff.valueColumn).toBeNull();
    const unselected = prepareGageStudy(idModel, [], {
      valueColumn: eff.valueColumn, partColumn: eff.partColumn, operatorColumn: eff.operatorColumn,
    });
    expect(unselected).toEqual(expect.objectContaining({ ok: false }));
    if (!unselected.ok) expect(unselected.reason).toContain('请选择测量列');

    // 离散整数也可以是真实测量：用户显式选择后必须照常解析。
    const selected = prepareGageStudy(idModel, [], {
      valueColumn: '批次ID', partColumn: '部件ID', operatorColumn: '操作员ID',
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.study.valueName).toBe('批次ID');
      expect(selected.study.partLabels).toEqual(['1', '2', '3']);
      expect(selected.study.operatorLabels).toEqual(['1', '2']);
      expect(selected.study.repeats).toBe(2);
    }
  });
});

describe('720-B5 多列工作表三套 GRR 与逐案例直连路径逐位一致', () => {
  const specs: Array<[string, { part: string; operator: string; value: number }[]]> = [
    ['螺钉高度', case1], ['平衡量值', case2], ['电阻值', case3],
  ];
  for (const [col, caseRows] of specs) {
    it(`${col}：%SV/ndc/全部分量一致（直连路径已被 gageFactory 黄金锁定）`, () => {
      const prep = prepareGageStudy(model, textCols, { valueColumn: col, partColumn: '部件', operatorColumn: '测试人' });
      expect(prep.ok).toBe(true);
      if (!prep.ok) return;
      const viaWorksheet = computeGageRR(prep.study.observations, null);
      // 直连构造:0 基 part 索引 + 按 (part) 计数 trial(单操作员)
      const partIds = [...new Set(caseRows.map((row) => row.part))];
      const trialCounter = new Map<string, number>();
      const direct: GageObservation[] = caseRows.map((row) => {
        const trial = trialCounter.get(row.part) ?? 0;
        trialCounter.set(row.part, trial + 1);
        return { part: partIds.indexOf(row.part), operator: 0, trial, value: row.value };
      });
      const viaDirect = computeGageRR(direct, null);
      expect(viaWorksheet.totalGageRR).toBeCloseTo(viaDirect.totalGageRR, 12);
      expect(viaWorksheet.ndc).toBe(viaDirect.ndc);
      expect(viaWorksheet.operatorCount).toBe(1);
      expect(viaWorksheet.components.map((c) => c.key)).toEqual(viaDirect.components.map((c) => c.key));
      viaWorksheet.components.forEach((component, index) => {
        expect(component.variance).toBeCloseTo(viaDirect.components[index].variance, 12);
        expect(component.pctStudyVar).toBeCloseTo(viaDirect.components[index].pctStudyVar, 12);
      });
    });
  }

  it('某列观测被破坏时仅该列失败,不影响其他列(失败隔离的引擎前提)', () => {
    const badRows = rows.map((row) => [...row]);
    badRows[0][1] = Number.NaN; // 螺钉高度首行坏值
    const badModel = computeVarModel('坏列.csv', MULTI_COLS, badRows);
    const prepBad = prepareGageStudy(badModel, textCols, { valueColumn: '螺钉高度', partColumn: '部件', operatorColumn: '测试人' });
    const prepGood = prepareGageStudy(badModel, textCols, { valueColumn: '平衡量值', partColumn: '部件', operatorColumn: '测试人' });
    expect(prepGood.ok).toBe(true);
    if (prepGood.ok) {
      const result = computeGageRR(prepGood.study.observations, null);
      expect(Number.isFinite(result.totalGageRR)).toBe(true);
    }
    if (prepBad.ok) {
      // NaN 行要么被 prepare 拒绝,要么 computeGageRR 抛错——不允许静默出数
      expect(() => computeGageRR(prepBad.study.observations, null)).toThrow();
    }
  });
});
