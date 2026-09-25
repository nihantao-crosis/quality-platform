/**
 * fix2609l · G22b-core(第 6 批跨组小尾巴,core 部分)。全部调用真实生产函数。
 * (6/14) resumeTightenedInspection 写 resume-tightened 转移记录，记录链审计按记录重放;
 * (8) 行首 Tab 缩进的逗号/分号文本不再被判为 Tab 分隔(parseMatrix 与帕累托预检同口径)。
 */
import { describe, expect, it } from 'vitest';
import {
  AQL_TRACE_LIMITS, MAX_AQL_RECORDS, auditAqlLedger, aqlTransitionActionLabel, freshSwitchStatus, isAqlBatchRecord,
  isAqlTransitionRecord, normalizeSwitchStatus, recordInspection, resumeTightenedInspection,
  type AqlTransitionRecord, type SwitchStatus,
} from '../aqlSwitch';
import { parseCategoryCounts, parseMatrix } from '../csv';
import { projectStoreValidationError } from '../../platform/project';

const AQL_KEY = 'qp-aql-state-v1';
const payload = (aqlSwitch: unknown) => ({
  aqlLot: 1000, aqlLevel: 'II', aqlAQL: 1.0, aqlRegime: 'percent',
  aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: JSON.parse(JSON.stringify(aqlSwitch)),
});

let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 1) + (clock += 60_000)).toISOString();
const batch = (status: SwitchStatus, nonconforming: number, batchId: string) => recordInspection(status, {
  lot: 1000, level: 'II', aql: 1.0, regime: 'percent', nonconforming, batchId, inspector: '检验员甲', inspectedAt: at(),
});

/** lot=1000/II/AQL 1.0:2 批 d=5 → 加严;加严再 5 批不接收 → 暂停。 */
function suspended(): SwitchStatus {
  let status = batch(batch(freshSwitchStatus(), 5, 'B1'), 5, 'B2');
  for (let i = 1; i <= 5; i += 1) status = batch(status, 5, `R${i}`);
  expect(status).toMatchObject({ state: 'tightened', suspended: true, tightenedRejections: 5 });
  return status;
}

describe('(6/14) resumeTightenedInspection 写入转移账本', () => {
  it('解除暂停追加 resume-tightened 转移记录(操作人/时间/前后状态),记录链审计 verified', () => {
    const before = suspended();
    const when = at();
    const resumed = resumeTightenedInspection(before, { operator: '质量主管', at: when });
    expect(resumed).toMatchObject({ state: 'tightened', suspended: false, tightenedRejections: 0 });
    // 修复前:records 长度不变(解除暂停不留痕)
    expect(resumed.records).toHaveLength(before.records.length + 1);
    const last = resumed.records[resumed.records.length - 1];
    expect(isAqlTransitionRecord(last)).toBe(true);
    expect(last).toMatchObject({
      kind: 'transition', action: 'resume-tightened', inspector: '质量主管', inspectedAt: when,
      stateBefore: 'tightened', stateAfter: 'tightened', switchingScoreBefore: 0, switchingScoreAfter: 0,
    });
    expect(aqlTransitionActionLabel('resume-tightened')).toMatch(/恢复加严检验/);
    expect(auditAqlLedger(resumed)).toMatchObject({ status: 'verified', notes: [] });
    // 写读对称:经项目闸门与归一化往返，记录原样保留
    expect(projectStoreValidationError(AQL_KEY, payload(resumed))).toBeNull();
    expect(normalizeSwitchStatus(JSON.parse(JSON.stringify(resumed))).records).toEqual(resumed.records);
    // 解除暂停后继续登记，仍按记录链重放一致
    const next = batch(resumed, 0, 'AFTER');
    expect(auditAqlLedger(next).status).toBe('verified');
    // 未填操作人如实记「未填写」;未暂停时是无操作，不写记录
    const anonymous = resumeTightenedInspection(before);
    expect((anonymous.records[anonymous.records.length - 1] as AqlTransitionRecord).inspector).toBe('未填写');
    expect(resumeTightenedInspection(resumed)).toEqual(normalizeSwitchStatus(resumed));
  });

  it('旧账本(无 resume 记录)仍按正式规则推定;未暂停时凭空出现的解除暂停记录按不一致拒绝', () => {
    const resumed = resumeTightenedInspection(suspended(), { operator: '主管', at: at() });
    const legacyShape = { ...resumed, records: resumed.records.filter(isAqlBatchRecord) };
    expect(auditAqlLedger(legacyShape).status).toBe('verified');
    expect(projectStoreValidationError(AQL_KEY, payload(legacyShape))).toBeNull();

    // 在未暂停的加严检验中伪造一条 resume-tightened 记录(前后状态/得分都自洽)
    const tightened = batch(batch(freshSwitchStatus(), 5, 'B1'), 5, 'B2');
    const forgedRecord = { ...resumed.records[resumed.records.length - 1], sequenceId: tightened.sequenceId };
    const forged = { ...tightened, records: [...tightened.records, forgedRecord] };
    expect(normalizeSwitchStatus(forged).records).toHaveLength(3); // 单条自洽校验放行
    const audit = auditAqlLedger(forged);
    expect(audit.status).toBe('mismatch');
    expect(audit.detail).toMatch(/未暂停/);
    expect(projectStoreValidationError(AQL_KEY, payload(forged))).toMatch(/不一致/);

    // 前后状态不是加严的 resume 记录在单条校验即被拒
    const bad = { ...forgedRecord, stateAfter: 'normal' };
    expect(normalizeSwitchStatus({ ...tightened, records: [...tightened.records, bad] } as unknown as SwitchStatus).records)
      .toHaveLength(2);
  });

  it('账本已满时解除暂停 fail-closed 抛错，不裁剪旧记录', () => {
    const base = suspended();
    const filler = base.records[0];
    const full: SwitchStatus = { ...base, records: Array.from({ length: MAX_AQL_RECORDS }, () => filler) };
    expect(() => resumeTightenedInspection(full, { operator: '主管' })).toThrow(/上限/);
    expect(() => resumeTightenedInspection(base, { operator: 'x'.repeat(AQL_TRACE_LIMITS.inspector + 1) })).toThrow(/操作人/);
  });
});

describe('(8) 行首 Tab 缩进的逗号/分号文本', () => {
  it('parseMatrix:「\\t列1,列2」按逗号拆分(修复前 Tab 与逗号打平被判为 Tab →「未检测到数值列」)', () => {
    const parsed = parseMatrix('\tx,y\n\t1,2\n\t3,4');
    expect('error' in parsed ? parsed.error : null).toBeNull();
    if ('error' in parsed) return;
    expect(parsed.colNames).toEqual(['x', 'y']);
    expect(parsed.rows).toEqual([[1, 2], [3, 4]]);
    const semi = parseMatrix('\t\ta;b;c\n\t\t1;2;3\n\t\t4;5;6');
    expect('error' in semi ? semi.error : semi.colNames).toEqual(['a', 'b', 'c']);
  });

  it('帕累托预检同口径:「\\t划伤,3」读成类别+频数(修复前被当成单列标签计数)', () => {
    const parsed = parseCategoryCounts('\t划伤,3\n\t毛刺,5');
    expect('error' in parsed ? parsed.error : parsed.rows).toEqual([
      { name: '划伤', count: 3 },
      { name: '毛刺', count: 5 },
    ]);
  });

  it('真正的 Tab 分隔不受影响:Tab 多于逗号、或 Tab 不全在行首时仍按 Tab', () => {
    // 行首空单元格 + Tab 分隔:Tab=2(只有 1 个在行首)> 逗号=1 → 仍按 Tab
    const tsv = parseMatrix('\tA\tB,备注\n\t1\t2\n\t3\t4');
    expect('error' in tsv ? tsv.error : tsv.colNames).toEqual(['A', 'B,备注']);
    const mixed = parseMatrix('x\ty,z\n1\t2\n3\t4');
    expect('error' in mixed ? 'error' : mixed.colNames[0]).toBe('x');
  });
});
