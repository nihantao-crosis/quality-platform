import { describe, expect, it } from 'vitest';
import {
  buildAqlReportData, freshSwitchStatus, MAX_AQL_RECORDS, normalizeSwitchStatus,
  recordInspection, restoreNormalInspection, type SwitchStatus,
} from '../aqlSwitch';

const batch = (batchId: string) => ({
  lot: 2000,
  level: 'II' as const,
  aql: 1.0,
  nonconforming: 0,
  batchId,
  inspector: '审核员',
  inspectedAt: `2026-07-15T08:00:0${batchId.length}.000Z`,
});

describe('AQL 外来状态与序列安全', () => {
  it('损坏记录被隔离，非法放宽失败关闭为正常检验', () => {
    const normalized = normalizeSwitchStatus({
      ...freshSwitchStatus(),
      state: 'reduced',
      switchingScore: 30,
      productionSteady: false,
      reducedApproved: false,
      records: [{}] as unknown as SwitchStatus['records'],
    });
    expect(normalized).toMatchObject({ state: 'normal', switchingScore: 0 });
    expect(normalized.records).toEqual([]);
    expect(normalized.note).toContain('准入条件不完整');
  });

  it('矛盾的暂停载荷按安全原则恢复为加严且累计至少 5 批', () => {
    const normalized = normalizeSwitchStatus({
      ...freshSwitchStatus(), state: 'normal', suspended: true, tightenedRejections: 0,
    });
    expect(normalized).toMatchObject({ state: 'tightened', suspended: true, tightenedRejections: 5 });
  });

  it('加严累计达到 5 批时即使载荷伪称未暂停也必须失败关闭', () => {
    const normalized = normalizeSwitchStatus({
      ...freshSwitchStatus(), state: 'tightened', suspended: false, tightenedRejections: 5,
    });
    expect(normalized).toMatchObject({ state: 'tightened', suspended: true, tightenedRejections: 5 });
    expect(() => recordInspection(normalized, batch('BYPASS'))).toThrow(/暂停/);
  });

  it('责任账本重新查正式方案并拒绝伪造的样本量/Ac/Re', () => {
    const valid = recordInspection(freshSwitchStatus(), batch('PLAN-OK'));
    const forged = {
      ...valid.records[0], finalCode: 'A', sampleSize: 1,
      acceptanceNumber: 999, rejectionNumber: 1000, fullInspection: false,
    };
    const normalized = normalizeSwitchStatus({ ...valid, records: [forged] });
    expect(normalized.records).toEqual([]);
  });

  it('责任账本拒绝正式方案字段正确但状态转移不可能的记录', () => {
    const tightened = normalizeSwitchStatus({ ...freshSwitchStatus(), state: 'tightened' });
    const valid = recordInspection(tightened, batch('TRANSITION-OK'));
    const forged = { ...valid.records[0], stateAfter: 'reduced' as const };
    const normalized = normalizeSwitchStatus({ ...valid, records: [forged] });
    expect(normalized.records).toEqual([]);
  });

  it('只有未暂停的放宽检验可以人工恢复正常', () => {
    expect(() => restoreNormalInspection(freshSwitchStatus())).toThrow(/只有放宽检验/);
    expect(() => restoreNormalInspection({
      ...freshSwitchStatus(), state: 'tightened', suspended: true, tightenedRejections: 5,
    })).toThrow(/暂停检验/);

    const reduced = {
      ...freshSwitchStatus(), state: 'reduced' as const, switchingScore: 30,
      productionSteady: true, reducedApproved: true,
    };
    expect(restoreNormalInspection(reduced)).toMatchObject({ state: 'normal', switchingScore: 0 });
  });

  it('参数新序列保留旧账本，但旧批不冒充当前序列最近批', () => {
    const old = recordInspection(freshSwitchStatus(), batch('OLD-B1'));
    expect(buildAqlReportData(2000, 'II', 1.0, old).latestRecord?.batchId).toBe('OLD-B1');

    const next: SwitchStatus = {
      ...freshSwitchStatus(), sequenceId: 'sequence-new', records: old.records,
    };
    const report = buildAqlReportData(2000, 'II', 1.0, next);
    expect(report.latestRecord).toBeNull();
    expect(report.records.map((record) => record.batchId)).toEqual(['OLD-B1']);

    const current = recordInspection(next, batch('NEW-B2'));
    expect(buildAqlReportData(2000, 'II', 1.0, current).latestRecord?.batchId).toBe('NEW-B2');
  });

  it('100% 全检发现不合格品时必须留下处置状态', () => {
    const input = {
      lot: 8, level: 'II' as const, aql: 0.65, nonconforming: 1,
      batchId: 'FULL-1', inspector: '审核员', inspectedAt: '2026-07-15T10:00:00.000Z',
    };
    expect(() => recordInspection(freshSwitchStatus(), input)).toThrow(/处置状态/);
    const recorded = recordInspection(freshSwitchStatus(), {
      ...input, nonconformingDisposition: 'pending',
    });
    expect(recorded.records[0]).toMatchObject({ fullInspection: true, nonconformingDisposition: 'pending' });
  });

  it('旧批次缺少处置字段时标为未记录，不凭空宣称已隔离', () => {
    const status = recordInspection(freshSwitchStatus(), {
      lot: 2000, level: 'II', aql: 1.0, nonconforming: 4,
      batchId: 'LEGACY-D', inspector: '审核员', inspectedAt: '2026-07-15T11:00:00.000Z',
    });
    const legacy = { ...status.records[0] } as Partial<(typeof status.records)[number]>;
    delete legacy.nonconformingDisposition;
    const normalized = normalizeSwitchStatus({ ...status, records: [legacy] as typeof status.records });
    expect(normalized.records[0].nonconformingDisposition).toBe('unrecorded');
  });

  it('责任账本达到上限后拒绝新增且不静默裁剪旧记录', () => {
    const one = recordInspection(freshSwitchStatus(), batch('CAP-1'));
    const records = Array.from({ length: MAX_AQL_RECORDS }, (_, index) => ({
      ...one.records[0], id: `capacity-${index}`, batchId: `CAP-${index}`,
    }));
    const full = normalizeSwitchStatus({ ...one, records });
    expect(full.records).toHaveLength(MAX_AQL_RECORDS);
    expect(() => recordInspection(full, batch('CAP-NEXT'))).toThrow(/导出项目.*归档/);
    expect(full.records).toEqual(records);
  });
});
