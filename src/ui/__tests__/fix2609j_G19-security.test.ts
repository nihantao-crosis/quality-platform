/**
 * fix2609j G19-security · CORE-06:AQL 责任账本记录链 ↔ 状态级字段交叉核对。
 * 全部夹具由真实生产函数(recordInspection / setSwitchConditions / restoreNormalInspection /
 * resumeTightenedInspection)生成，再按发现记录的复现方法篡改。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AQL_LEGACY_SEQUENCE_ID, auditAqlLedger, buildAqlReportData, freshSwitchStatus, isAqlBatchRecord,
  isAqlTransitionRecord, normalizeSwitchStatus, plansByState, recordInspection, restoreNormalInspection,
  resumeTightenedInspection, setSwitchConditions,
  type AqlLedgerRecord, type InspectionLevel, type SwitchStatus,
} from '../../core';
import { projectStoreValidationError } from '../../platform/project';

const AQL_KEY = 'qp-aql-state-v1';

const payload = (aqlSwitch: unknown, lot = 1000, level: InspectionLevel = 'II', aql = 1.0) => ({
  aqlLot: lot, aqlLevel: level, aqlAQL: aql, aqlRegime: aql >= 15 ? 'per100' : 'percent',
  aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: JSON.parse(JSON.stringify(aqlSwitch)),
});

let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 1) + (clock += 60_000)).toISOString();

const batch = (status: SwitchStatus, nonconforming: number, batchId: string, extra: Partial<Parameters<typeof recordInspection>[1]> = {}) => (
  recordInspection(status, {
    lot: 1000, level: 'II', aql: 1.0, regime: 'percent', nonconforming,
    batchId, inspector: '检验员甲', inspectedAt: at(), ...extra,
  })
);

/** 发现记录 trigger 1):lot=1000、II、AQL 1.0,连续 2 批 d=5 → 加严。 */
function legitTightened(): SwitchStatus {
  const b1 = batch(freshSwitchStatus(), 5, 'B1');
  const b2 = batch(b1, 5, 'B2');
  expect(b2.state).toBe('tightened');
  return b2;
}

/** 正常检验 10 批接收 → 得分 30,条件齐备后经人工转移记录进入放宽(v1.43 账本)。 */
function legitReducedWithTransition(): SwitchStatus {
  let status = freshSwitchStatus();
  for (let i = 1; i <= 10; i += 1) status = batch(status, 0, `N${i}`);
  expect(status).toMatchObject({ state: 'normal', switchingScore: 30 });
  status = setSwitchConditions(status, { productionSteady: true, reducedApproved: true }, { operator: '主管', at: at() });
  expect(status.state).toBe('reduced');
  return status;
}

describe('CORE-06 篡改回归：状态级字段必须等于记录链重放结果', () => {
  it('A:记录原样保留、状态改为正常+得分 28 → 拒绝(修复前被接受且一批内转放宽)', () => {
    const legit = legitTightened();
    expect(auditAqlLedger(legit).status).toBe('verified');
    expect(projectStoreValidationError(AQL_KEY, payload(legit))).toBeNull();

    const tampered = { ...legit, state: 'normal' as const, switchingScore: 28, tightenedRejections: 0, sinceSwitch: [] };
    const audit = auditAqlLedger(tampered);
    expect(audit.status).toBe('mismatch');
    expect(audit.detail).toMatch(/检验状态为正常，按记录链重放应为加严/);
    expect(projectStoreValidationError(AQL_KEY, payload(tampered))).toMatch(/记录链与状态字段不一致/);
  });

  it('只改 switchingScore(正常检验 3 批 +3 → 伪造 28)→ 拒绝', () => {
    let status = freshSwitchStatus();
    for (let i = 1; i <= 3; i += 1) status = batch(status, 0, `S${i}`);
    expect(status.switchingScore).toBe(9);
    expect(projectStoreValidationError(AQL_KEY, payload(status))).toBeNull();
    const tampered = { ...status, switchingScore: 28 };
    expect(auditAqlLedger(tampered).detail).toMatch(/转移得分为 28，按记录链重放应为 9/);
    expect(projectStoreValidationError(AQL_KEY, payload(tampered))).toMatch(/不一致/);
  });

  it('只改 state(加严 → 正常，得分/累计保持 0)→ 拒绝', () => {
    const tampered = { ...legitTightened(), state: 'normal' as const };
    expect(auditAqlLedger(tampered).status).toBe('mismatch');
    expect(projectStoreValidationError(AQL_KEY, payload(tampered))).toMatch(/不一致/);
  });

  it('只改 tightenedRejections / sinceSwitch → 拒绝', () => {
    const tightened = batch(batch(legitTightened(), 5, 'T1'), 5, 'T2');
    expect(tightened).toMatchObject({ state: 'tightened', tightenedRejections: 2 });
    expect(projectStoreValidationError(AQL_KEY, payload(tightened))).toBeNull();
    expect(projectStoreValidationError(AQL_KEY, payload({ ...tightened, tightenedRejections: 0 })))
      .toMatch(/加严累计不接收为 0 批，按记录链重放应为 2 批/);
    expect(projectStoreValidationError(AQL_KEY, payload({ ...tightened, sinceSwitch: ['A', 'A', 'A', 'A'] })))
      .toMatch(/转移窗口/);
  });

  it('C:删掉中间拒收记录 → 拒绝', () => {
    const legit = legitTightened();
    const tampered = { ...legit, records: legit.records.slice(1) };
    expect(auditAqlLedger(tampered).status).toBe('mismatch');
    expect(projectStoreValidationError(AQL_KEY, payload(tampered))).toMatch(/不一致/);

    // 删掉加严期内的一条拒收批，让累计少算一批
    const longer = batch(batch(legit, 5, 'T1'), 0, 'T2');
    const dropped = { ...longer, records: longer.records.filter((record) => !(isAqlBatchRecord(record) && record.batchId === 'T1')), tightenedRejections: 0 };
    expect(projectStoreValidationError(AQL_KEY, payload(dropped))).toMatch(/不一致/);
  });

  it('D:记录顺序颠倒 → 拒绝', () => {
    const legit = legitTightened();
    const tampered = { ...legit, records: [...legit.records].reverse() };
    expect(auditAqlLedger(tampered).status).toBe('mismatch');
    expect(projectStoreValidationError(AQL_KEY, payload(tampered))).toMatch(/不一致/);
  });

  it('B:空账本 + state=reduced/得分 30/条件齐备 → 拒绝', () => {
    const tampered = {
      ...freshSwitchStatus(), state: 'reduced' as const, switchingScore: 30, productionSteady: true, reducedApproved: true,
    };
    expect(auditAqlLedger(tampered).status).toBe('mismatch');
    expect(projectStoreValidationError(AQL_KEY, payload(tampered))).toMatch(/不一致/);
  });

  it('v1.43 账本删掉后一条人工转移记录 → 拒绝;唯一的转移记录被删 → 按旧账本推定并标记', () => {
    const reduced = legitReducedWithTransition();
    const withdrawn = setSwitchConditions(reduced, { reducedApproved: false }, { operator: '主管', at: at() });
    const after = batch(withdrawn, 0, 'AFTER');
    expect(after.records.filter(isAqlTransitionRecord)).toHaveLength(2);
    expect(auditAqlLedger(after).status).toBe('verified');
    expect(projectStoreValidationError(AQL_KEY, payload(after))).toBeNull();

    const transitions = after.records.filter(isAqlTransitionRecord);
    const dropLater = { ...after, records: after.records.filter((record) => record !== transitions[1]) };
    expect(auditAqlLedger(dropLater).detail).toMatch(/缺少状态转移记录/);
    expect(projectStoreValidationError(AQL_KEY, payload(dropLater))).toMatch(/不一致/);

    // 两条都删 = 退化为 v1.42 形态账本:只能推定 UI 本就允许的转移(得分 ≥30 才能转放宽)
    const dropAll = { ...after, records: after.records.filter(isAqlBatchRecord) };
    const audit = auditAqlLedger(dropAll);
    expect(audit.status).toBe('legacy');
    expect(audit.notes.join('')).toMatch(/历史账本未含转移记录/);
    expect(projectStoreValidationError(AQL_KEY, payload(dropAll))).toBeNull();
  });

  it('旧账本推定也不能凭空转放宽:得分未到 30 的正常→放宽缺口仍拒绝', () => {
    let status = freshSwitchStatus();
    for (let i = 1; i <= 4; i += 1) status = batch(status, 0, `L${i}`);
    const forged = {
      ...status, state: 'reduced' as const, productionSteady: true, reducedApproved: true, sinceSwitch: [],
    };
    // 顶层得分 12 <30 已被既有闸门拒绝;把得分也改成 30 同样要被记录链拒绝
    expect(projectStoreValidationError(AQL_KEY, payload({ ...forged, switchingScore: 30 }))).toMatch(/不一致/);
  });

  it('暂停后恢复加严不留痕，按正式规则推定;暂停期间凭空多出的放宽/正常仍拒绝', () => {
    let status = legitTightened();
    for (let i = 1; i <= 5; i += 1) status = batch(status, 5, `R${i}`);
    expect(status).toMatchObject({ suspended: true, tightenedRejections: 5 });
    expect(projectStoreValidationError(AQL_KEY, payload(status))).toBeNull();
    const resumed = resumeTightenedInspection(status);
    expect(auditAqlLedger(resumed).status).toBe('verified');
    expect(projectStoreValidationError(AQL_KEY, payload(resumed))).toBeNull();
    const next = batch(resumed, 0, 'AFTER-RESUME');
    expect(auditAqlLedger(next).status).toBe('verified');
    expect(projectStoreValidationError(AQL_KEY, payload({ ...status, suspended: false, tightenedRejections: 4 })))
      .toMatch(/不一致|暂停/);
  });

  it('序列必须连续，旧序列须在正常检验结束(不能把加严记录挪进旧序列逃避)', () => {
    const legit = legitTightened();
    const relabeled = {
      ...freshSwitchStatus(), sequenceId: 'sequence-new',
      records: legit.records.map((record) => ({ ...record, sequenceId: 'sequence-old' })),
    };
    expect(auditAqlLedger(relabeled).detail).toMatch(/在加严检验中结束/);
    expect(projectStoreValidationError(AQL_KEY, payload(relabeled))).toMatch(/不一致/);
  });

  it('专项报告数据携带审计结果', () => {
    expect(buildAqlReportData(1000, 'II', 1.0, legitTightened()).ledgerAudit.status).toBe('verified');
  });
});

describe('CORE-06 兼容：旧账本按明确策略接受并标记', () => {
  it('v1.31 近似版迁入(无序列号、无记录)的加严状态：接受并标记;凭空得分拒绝', () => {
    const legacy = { state: 'tightened', history: ['R', 'R'], sinceSwitch: [], note: '旧版加严' };
    const audit = auditAqlLedger(legacy as Partial<SwitchStatus>);
    expect(audit.status).toBe('legacy');
    expect(normalizeSwitchStatus(legacy as Partial<SwitchStatus>).sequenceId).toBe(AQL_LEGACY_SEQUENCE_ID);
    expect(projectStoreValidationError(AQL_KEY, payload(legacy))).toBeNull();
    expect(projectStoreValidationError(AQL_KEY, payload({ state: 'normal', switchingScore: 12, records: [] })))
      .toMatch(/没有任何批次记录/);
  });

  it('v1.32/33 无序列号账本：从加严状态续记的记录链接受;首个换表点之后的篡改仍拒绝', () => {
    const start = normalizeSwitchStatus({ state: 'tightened' });
    let status = start;
    for (let i = 1; i <= 5; i += 1) status = batch(status, 0, `LG${i}`);
    expect(status.state).toBe('normal');
    status = batch(status, 0, 'LG6');
    // v1.32/33 的载荷与记录都没有 sequenceId 字段
    const stripIds = (value: SwitchStatus) => {
      const raw = JSON.parse(JSON.stringify(value)) as Record<string, unknown> & { records: Array<Record<string, unknown>> };
      delete raw.sequenceId;
      raw.records.forEach((record) => { delete record.sequenceId; });
      return raw;
    };
    const legacy = stripIds(status);
    expect(auditAqlLedger(legacy as unknown as Partial<SwitchStatus>).status).toBe('legacy');
    expect(projectStoreValidationError(AQL_KEY, payload(legacy))).toBeNull();
    expect(projectStoreValidationError(AQL_KEY, payload({ ...legacy, switchingScore: 29 }))).toMatch(/不一致/);
    expect(projectStoreValidationError(AQL_KEY, payload({ ...legacy, state: 'tightened', switchingScore: 0 }))).toMatch(/不一致/);
  });

  it('v1.42 形态(人工转移不留痕)的放宽 → 恢复正常账本：接受并标记「历史账本未含转移记录」', () => {
    const reduced = legitReducedWithTransition();
    const inReduced = batch(reduced, 0, 'R-A');
    const restored = restoreNormalInspection(inReduced, '其他条件', { operator: '主管', at: at() });
    const v142 = { ...restored, records: restored.records.filter(isAqlBatchRecord) };
    const audit = auditAqlLedger(v142);
    expect(audit.status).toBe('legacy');
    expect(audit.notes.join('')).toMatch(/2 处人工状态转移/);
    expect(projectStoreValidationError(AQL_KEY, payload(v142))).toBeNull();
  });
});

describe('CORE-06 无误报：真实操作序列在每一步都能通过重放审计', () => {
  const LEVELS: InspectionLevel[] = ['II', 'I', 'III', 'S-3'];
  const AQLS = [1.0, 0.65, 2.5, 15];
  const LOTS = [8, 60, 500, 1000, 3200];

  function prng(seed: number) {
    let x = seed >>> 0;
    return () => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x / 2 ** 32;
    };
  }

  type Mode = 'v143' | 'v132';

  /**
   * v143:当前版本全部入口(人工转移写转移记录、只有正常检验才能换参数并开新序列)。
   * v132:v1.32/33 形态——无序列号、人工转移不留痕、任何状态下换参数都原地重置且保留记录。
   */
  function simulate(seed: number, steps: number, mode: Mode) {
    const rand = prng(seed);
    const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
    let level: InspectionLevel = 'II';
    let aql = 1.0;
    let status = mode === 'v132'
      ? normalizeSwitchStatus(rand() < 0.5 ? { state: 'tightened', sinceSwitch: ['R', 'A'] } : { state: 'normal' })
      : freshSwitchStatus();
    let sequence = 0;
    const strip = (value: SwitchStatus): SwitchStatus => (mode === 'v132'
      ? { ...value, records: value.records.filter((r: AqlLedgerRecord) => isAqlBatchRecord(r)) }
      : value);
    const snapshots: Array<{ status: SwitchStatus; level: InspectionLevel; aql: number }> = [];
    for (let step = 0; step < steps; step += 1) {
      const roll = rand();
      try {
        if (status.suspended) {
          status = roll < 0.7 ? resumeTightenedInspection(status) : status;
        } else if (roll < 0.72) {
          const lot = pick(LOTS);
          const plan = plansByState(lot, level, aql)[status.state];
          const reject = rand() < (status.state === 'tightened' ? 0.3 : 0.12);
          const nonconforming = reject ? Math.min(plan.re, plan.n) : (rand() < 0.2 ? Math.min(plan.ac, 1) : 0);
          status = recordInspection(status, {
            lot, level, aql, regime: aql >= 15 ? 'per100' : 'percent', nonconforming,
            batchId: `S${seed}-${step}`, inspector: '检验员', inspectedAt: at(),
            originalInspection: rand() > 0.08,
            nonconformingDisposition: plan.fullInspect && nonconforming > 0 ? 'pending' : undefined,
          });
        } else if (roll < 0.86) {
          status = setSwitchConditions(status, { productionSteady: rand() < 0.8, reducedApproved: rand() < 0.8 }, { operator: '主管', at: at() });
        } else if (roll < 0.9 && status.state === 'reduced') {
          status = restoreNormalInspection(status, '其他条件', { operator: '主管', at: at() });
        } else if (roll < 0.94 && (mode === 'v132' || status.state === 'normal')) {
          level = pick(LEVELS);
          aql = pick(AQLS);
          sequence += 1;
          status = mode === 'v132'
            // v1.32:原地重置、不分序列(甚至改回同一参数也重置)
            ? { ...freshSwitchStatus(), sequenceId: AQL_LEGACY_SEQUENCE_ID, records: status.records.map((r) => ({ ...r })) }
            // 与 appStore.setAql 同口径:只有正常检验才能换水平/AQL,新序列从初始态开始且保留总账。
            : { ...freshSwitchStatus(), sequenceId: `sequence-${seed}-${sequence}`, records: status.records.map((r) => ({ ...r })) };
        }
      } catch (error) {
        // 录入层拒绝(例如计点体系 d 上限)不改变状态
        if (!(error instanceof Error)) throw error;
      }
      status = strip(status);
      snapshots.push({ status, level, aql });
    }
    return snapshots;
  }

  it('v1.43 随机真实操作 × 多个种子：每一步 verified,完整载荷通过项目闸门;去掉转移记录(v1.42 形态)仍被接受', () => {
    const states = new Set<string>();
    for (const seed of [1, 7, 42, 2026, 99]) {
      const snapshots = simulate(seed, 160, 'v143');
      snapshots.forEach(({ status, level, aql }, index) => {
        states.add(status.suspended ? 'suspended' : status.state);
        const audit = auditAqlLedger(JSON.parse(JSON.stringify(status)));
        expect(audit, `seed ${seed} step ${index}: ${audit.detail}`).toMatchObject({ status: 'verified' });
        const v142: SwitchStatus = { ...status, records: status.records.filter((r: AqlLedgerRecord) => isAqlBatchRecord(r)) };
        const legacyAudit = auditAqlLedger(v142);
        expect(legacyAudit.status, `seed ${seed} step ${index} (v1.42 形态): ${legacyAudit.detail}`).not.toBe('mismatch');
        if (index % 7 === 0 || index === snapshots.length - 1) {
          expect(projectStoreValidationError(AQL_KEY, payload(status, 1000, level, aql)), `seed ${seed} step ${index}`).toBeNull();
        }
      });
    }
    // 夹具确实覆盖了加严、放宽与暂停
    expect([...states]).toEqual(expect.arrayContaining(['normal', 'reduced', 'tightened', 'suspended']));
  });

  it('v1.32/33 形态随机历史(无序列号、原地重置):每一步都被接受并标记为 legacy', () => {
    for (const seed of [3, 11, 58, 777]) {
      simulate(seed, 120, 'v132').forEach(({ status }, index) => {
        const raw = JSON.parse(JSON.stringify(status));
        delete raw.sequenceId;
        raw.records.forEach((record: Record<string, unknown>) => { delete record.sequenceId; });
        const audit = auditAqlLedger(raw);
        expect(audit.status, `seed ${seed} step ${index}: ${audit.detail}`).toBe('legacy');
      });
    }
  });
});

describe('CORE-06 持久化入口：篡改的独立账本启动即隔离并保留原文', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('localStorage 中 state/得分被改的账本不会被采信，原文保留', async () => {
    const legit = legitTightened();
    const tampered = JSON.stringify(payload({ ...legit, state: 'normal', switchingScore: 28, sinceSwitch: [] }));
    localStorage.setItem(AQL_KEY, tampered);
    const { useApp } = await import('../../store/appStore');
    expect(useApp.getState().aqlSwitch.state).toBe('normal');
    expect(useApp.getState().aqlSwitch.switchingScore).toBe(0);
    expect(useApp.getState().aqlSwitch.records).toHaveLength(0);
    expect(useApp.getState().aqlLedgerFault).toBeTruthy();
    expect(localStorage.getItem(AQL_KEY)).toBe(tampered);
  });
});
