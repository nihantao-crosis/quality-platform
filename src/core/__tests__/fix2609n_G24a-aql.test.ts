/**
 * fix2609n · G24a-aql(第 7 批对抗复审 P2×2,同根)——core 部分。全部调用真实生产函数，不 mock 被测模块。
 *
 * A1:auditAqlLedger 对已结束的检验序列只看末条 stateAfter,序列内部既不重放也不统计断点/重置:
 *   (1) v1.32 真实「加严中改 AQL」重置账本升级后，在 HEAD 正常检验中再改一次 AQL(开启新序列),
 *       legacy 推定重置警示随之消失、审计变成 verified;
 *   (2) 取真实加严账本(序列 S1),末尾追加一条 fresh 正常批(与加严之间是断点)，顶层换成没有记录的
 *       新序列 S2 → 「加严→正常」被静默伪造成 verified(改标 sequence-legacy-v2 与保留真实序列号两种)。
 * 修法：已结束的序列同样重放——legacy 序列走与当前序列相同的候选引擎(推定重置计数/警示),
 * 非 legacy 序列从初始态严格重放(断点即 mismatch)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AQL_LEGACY_SEQUENCE_ID, auditAqlLedger, freshSwitchStatus, isAqlBatchRecord, normalizeSwitchStatus,
  plansByState, recordInspection, restoreNormalInspection, resumeTightenedInspection, setSwitchConditions,
  type AqlBatchRecord, type AqlLedgerRecord, type InspectionLevel, type SwitchStatus,
} from '..';
import { projectStoreValidationError } from '../../platform/project';

interface Snapshot {
  op: string;
  params: { lot: number; level: InspectionLevel; aql: number };
  top: Record<string, unknown>;
  history: string;
  sinceSwitch: string;
  recordCount: number;
}
interface Ledger { records: Array<Record<string, unknown>>; snapshots: Snapshot[] }
interface Fixture { cases: Array<Ledger & { name: string }>; random: Array<Ledger & { seed: number }> }

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/aql-v1.32-ledgers.json'), 'utf8')) as Fixture;
const rawAt = (ledger: Ledger, snap: Snapshot) => ({
  ...snap.top,
  history: snap.history.split(''),
  sinceSwitch: snap.sinceSwitch.split(''),
  records: ledger.records.slice(0, snap.recordCount).map((record) => ({ ...record })),
}) as unknown as Partial<SwitchStatus> & { records: AqlBatchRecord[] };
const byName = (name: string) => fixture.cases.find((item) => item.name === name)!;
const allLedgers: Array<[string, Ledger]> = [
  ...fixture.cases.map((item) => [item.name, item] as [string, Ledger]),
  ...fixture.random.map((item) => [`seed ${item.seed}`, item] as [string, Ledger]),
];

const AQL_KEY = 'qp-aql-state-v1';
const payload = (aqlSwitch: unknown, level: InspectionLevel = 'II', aql = 1.0) => ({
  aqlLot: 1000, aqlLevel: level, aqlAQL: aql, aqlRegime: aql >= 15 ? 'per100' : 'percent',
  aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: JSON.parse(JSON.stringify(aqlSwitch)),
});
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 1) + (clock += 60_000)).toISOString();
const b = (s: SwitchStatus, d: number, id: string) => recordInspection(s, {
  lot: 1000, level: 'II', aql: 1.0, regime: 'percent', nonconforming: d, batchId: id, inspector: 'QA', inspectedAt: at(),
});
/** 与 appStore.setAql 同口径：正常检验下换检验水平/AQL → 新序列从初始态开始，总账原样保留。 */
const newSequence = (status: SwitchStatus, sequenceId: string): SwitchStatus => ({
  ...freshSwitchStatus(), sequenceId, records: status.records.map((record) => ({ ...record })),
});
const tightened = () => b(b(freshSwitchStatus(), 5, 'T1'), 5, 'T2');
/** 复审构造：真实加严账本 + 末尾一条从 fresh 状态生成的正常批 N1(断点) + 顶层换成无记录的新序列。 */
function forgedEndedSequence(recordSequenceId: string | null) {
  const s = tightened();
  const raw = clone(s) as SwitchStatus;
  const recordSeq = recordSequenceId ?? s.sequenceId;
  raw.records.forEach((record) => { record.sequenceId = recordSeq; });
  const n1 = b({ ...freshSwitchStatus(), sequenceId: recordSeq }, 0, 'N1').records[0];
  raw.records.push(clone(n1));
  return {
    ...raw, sequenceId: 'sequence-attacker-2', state: 'normal' as const, switchingScore: 0, tightenedRejections: 0,
    suspended: false, sinceSwitch: [], history: [],
  };
}

describe('A1 已结束序列同样重放：legacy 推定重置警示不能被一次正常改参抹掉', () => {
  it('v1.32 真实「加严中改 AQL」账本升级后在 HEAD 正常检验中再改一次 AQL:仍为 legacy、警示仍在', () => {
    const ledger = byName('tightened-then-setaql-reset');
    const last = ledger.snapshots[ledger.snapshots.length - 1];
    const loaded = normalizeSwitchStatus(rawAt(ledger, last));
    const before = auditAqlLedger(loaded);
    expect(before.status).toBe('legacy');
    expect(before.alerts).toHaveLength(1);

    const changed = newSequence(loaded, 'sequence-head-1');
    const after = auditAqlLedger(clone(changed));
    expect(after.status, after.detail).toBe('legacy');
    expect(after.alerts).toEqual(before.alerts);
    expect(after.notes.join('\n')).toMatch(/1 处按 v1\.32\/33「更改检验水平\/AQL 即重置」推定的不留痕重置/);
    // 新序列继续正常录入、转放宽，警示依然随账本存在
    let next = changed;
    for (let i = 0; i < 10; i += 1) next = b(next, 0, `H${i}`);
    next = setSwitchConditions(next, { productionSteady: true, reducedApproved: true }, { operator: '主管', at: at() });
    expect(next.state).toBe('reduced');
    const later = auditAqlLedger(clone(next));
    expect(later.status, later.detail).toBe('legacy');
    expect(later.alerts).toHaveLength(1);
    expect(projectStoreValidationError(AQL_KEY, payload(next))).toBeNull();
  });

  it('复审 f:改标 sequence-legacy-v2 + 伪造正常批收尾 + 新序列(无记录) → 带「加严→正常」警示，不再是 verified', () => {
    const raw = forgedEndedSequence(AQL_LEGACY_SEQUENCE_ID);
    const audit = auditAqlLedger(clone(raw));
    expect(audit.status).toBe('legacy');
    expect(audit.alerts.join('\n')).toMatch(/由旧版本推定从加严检验.*重置为正常检验，无法核对（1 处）/);
    // 继续正常录 10 批并转放宽，警示不消失
    let next = clone(raw) as SwitchStatus;
    for (let i = 0; i < 10; i += 1) next = b(next, 0, `X${i}`);
    next = setSwitchConditions(next, { productionSteady: true, reducedApproved: true }, { operator: 'x', at: at() });
    expect(next.state).toBe('reduced');
    expect(auditAqlLedger(clone(next)).alerts).toHaveLength(1);
  });

  it('复审 g:保留真实序列号 S1 加严 + 伪造 S1 正常批 + 新序列 S2 → 记录链断开，按损坏拒绝', () => {
    const raw = forgedEndedSequence(null);
    const audit = auditAqlLedger(clone(raw));
    expect(audit.status).toBe('mismatch');
    expect(audit.detail).toMatch(/批次「N1」的检验前状态为正常，按记录链重放应为加严/);
    expect(projectStoreValidationError(AQL_KEY, payload(raw))).toMatch(/记录链/);
    let next = clone(raw) as SwitchStatus;
    for (let i = 0; i < 10; i += 1) next = b(next, 0, `X${i}`);
    next = setSwitchConditions(next, { productionSteady: true, reducedApproved: true }, { operator: 'x', at: at() });
    expect(projectStoreValidationError(AQL_KEY, payload(next))).not.toBeNull();
  });

  it('已结束的现行序列内部被删掉中间拒收批/改得分 → mismatch(此前只看末条状态会放行)', () => {
    let s = b(b(b(freshSwitchStatus(), 0, 'A1'), 0, 'A2'), 5, 'R1');
    s = b(s, 0, 'A3');
    expect(s.state).toBe('normal');
    const ended = newSequence(s, 'sequence-next');
    expect(auditAqlLedger(clone(ended)).status).toBe('verified');

    const dropped = clone(ended);
    dropped.records.splice(2, 1); // 删掉 R1:A3 的得分(清零后 +0)与 A2 的得分不连续
    expect(auditAqlLedger(dropped).status).toBe('mismatch');

    const rescored = clone(ended);
    (rescored.records[3] as AqlBatchRecord).switchingScoreAfter = 9;
    expect(auditAqlLedger(rescored).status).toBe('mismatch');
  });

  it('已结束的 legacy 序列:兼容标记(v1.32 严一档计分)随账本保留、仍为 legacy,无加严警示', () => {
    const ledger = byName('ii-150000-aql4-two-accepted');
    const raw = rawAt(ledger, ledger.snapshots[ledger.snapshots.length - 1]);
    const loaded = normalizeSwitchStatus(raw);
    const ended = newSequence(loaded, 'sequence-head-2');
    const audit = auditAqlLedger(clone(ended));
    expect(audit.status, audit.detail).toBe('legacy');
    expect(audit.alerts).toEqual([]);
    expect(audit.notes.join('\n')).toMatch(/按 v1\.32 严一档规则计分/);
  });

  it('v1.32 真实夹具每一步「升级到 HEAD + 正常检验下改一次 AQL」:都不是 mismatch,既有警示不丢', () => {
    const failures: string[] = [];
    for (const [label, ledger] of allLedgers) {
      ledger.snapshots.forEach((snap, step) => {
        const loaded = normalizeSwitchStatus(rawAt(ledger, snap));
        if (loaded.state !== 'normal') return; // appStore.setAql 只允许正常检验换参数
        const before = auditAqlLedger(loaded);
        const after = auditAqlLedger(clone(newSequence(loaded, `sequence-up-${step}`)));
        // 有旧记录的账本开启新序列后仍须标记为 legacy(无记录的快照没有可核对内容，只要求不误拒)。
        const expected = loaded.records.length > 0 ? 'legacy' : 'verified';
        if (after.status !== expected) failures.push(`${label} step ${step}: ${after.status} ${after.detail}`);
        if (before.alerts.length > 0 && after.alerts.length === 0) failures.push(`${label} step ${step}: 警示丢失`);
      });
    }
    expect(failures).toEqual([]);
  });

  it('v1.32 形态随机历史 → 升级后按 v1.43 规则随机操作(多次开新序列):每一步不误拒，警示一旦出现不再消失', () => {
    const LEVELS: InspectionLevel[] = ['II', 'I', 'III', 'S-3'];
    const AQLS = [1.0, 0.65, 2.5, 15];
    const LOTS = [8, 60, 500, 1000, 3200];
    let checked = 0;
    let sawAlert = false;
    for (const seed of [5, 13, 21, 34, 55, 89]) {
      let x = seed >>> 0;
      const rand = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
      const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
      let level: InspectionLevel = 'II';
      let aql = 1.0;
      let status = normalizeSwitchStatus({ state: 'normal' });
      let alerted = false;
      let sequence = 0;
      for (let step = 0; step < 200; step += 1) {
        const legacyEra = step < 80;
        const roll = rand();
        try {
          if (status.suspended) {
            status = roll < 0.7 ? resumeTightenedInspection(status) : status;
          } else if (roll < 0.72) {
            const lot = pick(LOTS);
            const plan = plansByState(lot, level, aql)[status.state];
            const reject = rand() < (status.state === 'tightened' ? 0.3 : 0.15);
            const nonconforming = reject ? Math.min(plan.re, plan.n) : 0;
            status = recordInspection(status, {
              lot, level, aql, regime: aql >= 15 ? 'per100' : 'percent', nonconforming,
              batchId: `U${seed}-${step}`, inspector: '检验员', inspectedAt: at(),
              nonconformingDisposition: plan.fullInspect && nonconforming > 0 ? 'pending' : undefined,
            });
          } else if (roll < 0.86) {
            status = setSwitchConditions(status, { productionSteady: rand() < 0.8, reducedApproved: rand() < 0.8 }, { operator: '主管', at: at() });
          } else if (roll < 0.9 && status.state === 'reduced') {
            status = restoreNormalInspection(status, '其他条件', { operator: '主管', at: at() });
          } else if (roll < 0.97 && (legacyEra || status.state === 'normal')) {
            level = pick(LEVELS);
            aql = pick(AQLS);
            sequence += 1;
            status = legacyEra
              // v1.32/33:任何状态下原地重置、不分序列
              ? { ...freshSwitchStatus(), sequenceId: AQL_LEGACY_SEQUENCE_ID, records: status.records.map((r) => ({ ...r })) }
              : newSequence(status, `sequence-u${seed}-${sequence}`);
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
        // legacy 时代人工转移不留痕
        if (legacyEra) status = { ...status, records: status.records.filter((r: AqlLedgerRecord) => isAqlBatchRecord(r)) };
        const audit = auditAqlLedger(clone(status));
        expect(audit.status, `seed ${seed} step ${step}: ${audit.detail}`).not.toBe('mismatch');
        if (!legacyEra && alerted) expect(audit.alerts.length, `seed ${seed} step ${step}: 警示丢失`).toBeGreaterThan(0);
        if (!legacyEra && audit.alerts.length > 0) { alerted = true; sawAlert = true; }
        checked += 1;
      }
    }
    expect(checked).toBe(1200);
    expect(sawAlert).toBe(true);
  });
});
