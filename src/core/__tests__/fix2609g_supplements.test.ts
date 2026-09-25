/**
 * fix2609g G11-supplements 回归(编排方补充核实 S-1 / S-2)。
 * - S-1:EWMA/CUSUM 设计常数(λ、L、k、h)与 Minitab 默认不同,披露文案由唯一格式化函数生成;
 * - S-2:勾选管理条件 / 因其他条件恢复正常检验引起的正式状态转移必须写入责任账本
 *   (kind:'transition'),读取侧白名单 + 交叉校验认识该类型,旧账本仍可读,账本满 fail-closed。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_AQL_RECORDS, buildAqlReportData, cusumSeries, ewmaSeries, freshSwitchStatus, isAqlBatchRecord,
  isAqlTransitionRecord, normalizeSwitchStatus, recordInspection, restoreNormalInspection, setSwitchConditions,
  switchConditionsTransition, type SwitchStatus,
} from '..';
import { CUSUM_K, cusumH, cusumParamsText, ewmaParamsText } from '../advancedSpcParams';

const AT = '2026-09-26T08:00:00.000Z';
const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];

/** 真实生产函数构造:连续接收批累积到得分 ≥30(Ac=3 → 每批 +3)。 */
function eligibleNormal(): SwitchStatus {
  let status = freshSwitchStatus();
  for (let i = 1; i <= 10; i++) {
    status = recordInspection(status, {
      lot: 2000, level: 'II', aql: 1.0, regime: 'percent', nonconforming: 0,
      batchId: `B-${i}`, inspector: '张检', inspectedAt: `2026-09-${String(i).padStart(2, '0')}T08:00:00.000Z`,
    });
  }
  expect(status.state).toBe('normal');
  expect(status.switchingScore).toBeGreaterThanOrEqual(30);
  return status;
}

function reducedStatus(): SwitchStatus {
  const armed = setSwitchConditions(eligibleNormal(), { productionSteady: true }, { operator: '李工', at: AT });
  const reduced = setSwitchConditions(armed, { reducedApproved: true }, { operator: '李工', at: AT });
  expect(reduced.state).toBe('reduced');
  return reduced;
}

describe('S-1 EWMA/CUSUM 设计常数披露', () => {
  it('文案与计算实际所用常数同源,并注明与 Minitab 默认的差异', () => {
    const ewma = ewmaSeries([1, 2, 3], 2, 1);
    expect(ewmaParamsText(ewma.lambda, ewma.L)).toBe('λ=0.2 · L=2.7(Montgomery 口径,Minitab 默认 L=3σ)');
    expect(cusumParamsText(CUSUM_K, cusumH(true))).toBe('k=0.5 · h=4(与 Minitab 默认一致)');
    expect(cusumParamsText(CUSUM_K, cusumH(false))).toBe('k=0.5 · h=5(Montgomery 口径,Minitab 默认 h=4)');
    const cusum = cusumSeries([1, 2, 3], 2, 2, CUSUM_K, cusumH(false));
    expect(cusum.K).toBe(CUSUM_K * 2);
    expect(cusum.H).toBe(5 * 2);
  });
});

describe('S-2 AQL 人工状态转移写入责任账本', () => {
  it('勾选两项管理条件转入放宽时追加 conditions-met 转移记录(前后状态/得分/条件快照/操作人/时间)', () => {
    const before = eligibleNormal();
    const onlySteady = setSwitchConditions(before, { productionSteady: true }, { operator: '李工', at: AT });
    // 只勾一项不发生转移,不写账本
    expect(onlySteady.state).toBe('normal');
    expect(onlySteady.records).toHaveLength(before.records.length);
    expect(switchConditionsTransition(onlySteady, { reducedApproved: true })).toBe('conditions-met');

    const reduced = setSwitchConditions(onlySteady, { reducedApproved: true }, { operator: '李工', at: AT });
    expect(reduced.state).toBe('reduced');
    expect(reduced.records).toHaveLength(before.records.length + 1);
    const appended = reduced.records[reduced.records.length - 1];
    expect(isAqlTransitionRecord(appended)).toBe(true);
    expect(appended).toEqual({
      kind: 'transition',
      id: `${AT}-T${before.records.length + 1}`,
      sequenceId: before.sequenceId,
      action: 'conditions-met',
      inspector: '李工',
      inspectedAt: AT,
      stateBefore: 'normal',
      stateAfter: 'reduced',
      switchingScoreBefore: before.switchingScore,
      switchingScoreAfter: before.switchingScore,
      productionSteady: true,
      reducedApproved: true,
      note: '转移得分 ≥30、生产稳定且负责部门同意 → 转放宽检验（表 2-C）',
    });
    // 读回(normalize)保持原样
    expect(normalizeSwitchStatus(JSON.parse(JSON.stringify(reduced)))).toEqual(reduced);
  });

  it('放宽期间取消管理条件 / 因其他条件恢复正常检验都写转移记录', () => {
    const reduced = reducedStatus();
    const withdrawn = setSwitchConditions(reduced, { productionSteady: false }, { operator: '王主管', at: AT });
    expect(withdrawn.state).toBe('normal');
    expect(last(withdrawn.records)).toMatchObject({
      kind: 'transition', action: 'conditions-withdrawn', stateBefore: 'reduced', stateAfter: 'normal',
      switchingScoreAfter: 0, productionSteady: false, reducedApproved: true, inspector: '王主管',
    });

    const restored = restoreNormalInspection(reduced, '负责部门因其他条件决定恢复正常检验', { operator: '王主管', at: AT });
    expect(restored.state).toBe('normal');
    expect(last(restored.records)).toMatchObject({
      kind: 'transition', action: 'restore-normal', stateBefore: 'reduced', stateAfter: 'normal',
      switchingScoreAfter: 0, note: '负责部门因其他条件决定恢复正常检验', inspector: '王主管',
    });
    // 未给操作人的旧调用方仍可工作,如实标注「未填写」而非伪造
    expect(last(restoreNormalInspection(reduced).records)).toMatchObject({ inspector: '未填写' });
  });

  it('转移记录不冒充最新批次;报表账本含转移记录', () => {
    const reduced = reducedStatus();
    const report = buildAqlReportData(2000, 'II', 1.0, reduced, 'percent');
    expect(report.latestRecord?.batchId).toBe('B-10');
    expect(report.records.filter(isAqlTransitionRecord)).toHaveLength(1);
    expect(report.records.filter(isAqlBatchRecord)).toHaveLength(10);
    // 转移记录后的下一批默认批次号仍按批次条数编号
    const next = recordInspection(reduced, { lot: 2000, level: 'II', aql: 1.0, regime: 'percent', nonconforming: 0, inspector: '张检' });
    expect(last(next.records)).toMatchObject({ batchId: '批次-0011', stateBefore: 'reduced' });
  });

  it('旧格式账本(无 kind 的批次记录)仍原样可读', () => {
    const legacy = JSON.parse(JSON.stringify(eligibleNormal())) as SwitchStatus;
    expect(legacy.records.every((record) => !('kind' in record))).toBe(true);
    const normalized = normalizeSwitchStatus(legacy);
    expect(normalized.records).toHaveLength(legacy.records.length);
    expect(normalized.records).toEqual(legacy.records);
  });

  it('篡改的转移记录被交叉校验拒绝', () => {
    const reduced = reducedStatus();
    const index = reduced.records.length - 1;
    const transition = reduced.records[index];
    const tampered: Array<[string, Record<string, unknown>]> = [
      ['放宽前得分不足 30', { ...transition, switchingScoreBefore: 12, switchingScoreAfter: 12 }],
      ['条件快照与动作矛盾', { ...transition, reducedApproved: false }],
      ['前后状态与动作矛盾', { ...transition, stateAfter: 'tightened' }],
      ['放宽→正常未清零', { ...transition, action: 'restore-normal', stateBefore: 'reduced', stateAfter: 'normal' }],
      ['未知动作', { ...transition, action: 'forced' }],
      ['白名单外字段', { ...transition, lot: 2000 }],
      ['缺少操作人', { ...transition, inspector: '  ' }],
      ['缺少序列号', { ...transition, sequenceId: undefined }],
      ['未知记录类型', { ...transition, kind: 'override' }],
    ];
    for (const [label, forged] of tampered) {
      const records = [...reduced.records];
      records[index] = forged as never;
      const normalized = normalizeSwitchStatus({ ...reduced, records });
      expect(normalized.records, label).toHaveLength(reduced.records.length - 1);
    }
    // 批次记录冒充 kind 同样拒绝
    const batchForged = { ...reduced.records[0], kind: 'batch' } as never;
    expect(normalizeSwitchStatus({ ...reduced, records: [batchForged] }).records).toHaveLength(0);
  });

  it('账本满 1000 条时人工转移同样 fail-closed,不裁剪旧记录', () => {
    const base = eligibleNormal();
    const template = base.records[0];
    const records = Array.from({ length: MAX_AQL_RECORDS }, (_, index) => ({
      ...template, id: `capacity-${index}`, batchId: `CAP-${index}`,
    }));
    const full = normalizeSwitchStatus({ ...base, productionSteady: true, records });
    expect(full.records).toHaveLength(MAX_AQL_RECORDS);
    expect(() => setSwitchConditions(full, { reducedApproved: true }, { operator: '李工' })).toThrow(/导出项目.*归档/);
    // 不发生转移的条件变更不写账本,仍可操作
    expect(setSwitchConditions(full, { productionSteady: false }).records).toHaveLength(MAX_AQL_RECORDS);

    const reduced = reducedStatus();
    const fullReduced = normalizeSwitchStatus({
      ...reduced,
      records: [...Array.from({ length: MAX_AQL_RECORDS - reduced.records.length }, (_, index) => ({
        ...template, id: `cap-r-${index}`, batchId: `CAP-R-${index}`,
      })), ...reduced.records],
    });
    expect(fullReduced.records).toHaveLength(MAX_AQL_RECORDS);
    expect(() => restoreNormalInspection(fullReduced)).toThrow(/上限/);
    expect(() => setSwitchConditions(fullReduced, { productionSteady: false })).toThrow(/上限/);
  });
});
