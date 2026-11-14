/**
 * fix2609m · G23b-aql(最终对抗复审 P2)——core 部分。全部调用真实生产函数，不 mock 被测模块。
 *
 * B1:v1.32 时期合法 legacy 账本被链审计误拒。v1.32 的严一档评估不比较样本量，d≤严一档 Ac 即 +3;
 *     v1.34 起样本量不同改为「不可比 → 清零」。夹具 fixtures/aql-v1.32-ledgers.json 由
 *     scripts/gen-aql-v132-ledgers.mjs 用 v1.32.0(fa4b539)生产代码真实生成，绝不用现行
 *     recordInspection 伪造旧形态。
 * B3:删光 sequenceId 冒充 v1.32 legacy 的篡改被拒;legacy 推定把加严/暂停重置为正常时给出独立警示。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AQL_LEGACY_SEQUENCE_ID, auditAqlLedger, buildAqlReportData, freshSwitchStatus, normalizeSwitchStatus,
  recordInspection, setSwitchConditions, type AqlBatchRecord, type InspectionLevel, type SwitchStatus,
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
interface Fixture {
  divergentBatches: number;
  cases: Array<Ledger & { name: string }>;
  random: Array<Ledger & { seed: number }>;
}

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/aql-v1.32-ledgers.json'), 'utf8')) as Fixture;

/** 按生成器约定精确还原 v1.32 写出的 aqlSwitch 原文。 */
type RawSwitch = Partial<SwitchStatus> & { records: AqlBatchRecord[] };
const rawAt = (ledger: Ledger, snap: Snapshot): RawSwitch => ({
  ...snap.top,
  history: snap.history.split(''),
  sinceSwitch: snap.sinceSwitch.split(''),
  records: ledger.records.slice(0, snap.recordCount).map((record) => ({ ...record })),
}) as unknown as RawSwitch;
const lastOf = <T,>(items: readonly T[]): T => items[items.length - 1];

/** v1.32 独立账本载荷(qp-aql-state-v1 口径;v1.32 没有 aqlRegime 字段)。 */
const aqlPayload = (aqlSwitch: unknown, snap: Snapshot) => ({
  aqlLot: Math.max(2, snap.params.lot || 1000), aqlLevel: snap.params.level, aqlAQL: snap.params.aql,
  aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: JSON.parse(JSON.stringify(aqlSwitch)),
});

const byName = (name: string) => fixture.cases.find((item) => item.name === name)!;
const allLedgers: Array<[string, Ledger]> = [
  ...fixture.cases.map((item) => [item.name, item] as [string, Ledger]),
  ...fixture.random.map((item) => [`seed ${item.seed}`, item] as [string, Ledger]),
];

describe('B1 v1.32 真实账本(fa4b539 生产代码生成)不得被链审计误拒', () => {
  it('夹具确实是 v1.32 形态且覆盖分歧格', () => {
    expect(fixture.divergentBatches).toBeGreaterThanOrEqual(20);
    for (const [, ledger] of allLedgers) {
      for (const record of ledger.records) {
        expect(record).not.toHaveProperty('sequenceId');
        expect(record).not.toHaveProperty('regime');
        expect(record).not.toHaveProperty('nonconformingDisposition');
      }
      for (const snap of ledger.snapshots) expect(snap.top).not.toHaveProperty('sequenceId');
    }
  });

  it('复审确定性复现:II/150000/AQL 4.0 两批接收，得分 3→6 → legacy 接受并注明按 v1.32 严一档规则计分', () => {
    const ledger = byName('ii-150000-aql4-two-accepted');
    const last = lastOf(ledger.snapshots);
    const raw = rawAt(ledger, last);
    expect(raw).toMatchObject({ state: 'normal', switchingScore: 6 });
    expect(raw.records.map((record) => [record.sampleSize, record.acceptanceNumber, record.switchingScoreAfter]))
      .toEqual([[315, 21, 3], [315, 21, 6]]);
    const audit = auditAqlLedger(raw);
    expect(audit.status, audit.detail).toBe('legacy');
    // 首批之前的得分未知(旧序列从中途接入)，只有 L2 能证明按 v1.32 规则 +3。
    expect(audit.notes.join('\n')).toMatch(/1 处按 v1\.32 严一档规则计分/);
    expect(projectStoreValidationError('qp-aql-state-v1', aqlPayload(raw, last))).toBeNull();
    // 旧 prefs 内嵌入口同一口径
    expect(projectStoreValidationError('qp-prefs-v1', { state: { aqlSwitch: raw }, version: 2 })).toBeNull();
  });

  it('全部快照(确定性剧本 + 8 个随机种子的每一步)链审计都不是 mismatch,项目闸门放行', () => {
    const failures: string[] = [];
    for (const [label, ledger] of allLedgers) {
      ledger.snapshots.forEach((snap, step) => {
        const raw = rawAt(ledger, snap);
        const audit = auditAqlLedger(raw);
        const gate = projectStoreValidationError('qp-aql-state-v1', aqlPayload(raw, snap));
        if (audit.status === 'mismatch' || gate) failures.push(`${label} step ${step}: ${audit.detail || gate}`);
      });
    }
    expect(failures).toEqual([]);
  });

  it('HEAD 载入后回写的形态(normalizeSwitchStatus 补齐序列号/质量表示/处置)同样接受', () => {
    const failures: string[] = [];
    for (const [label, ledger] of allLedgers) {
      ledger.snapshots.forEach((snap, step) => {
        const resaved = JSON.parse(JSON.stringify(normalizeSwitchStatus(rawAt(ledger, snap))));
        expect(resaved.sequenceId).toBe(AQL_LEGACY_SEQUENCE_ID);
        const audit = auditAqlLedger(resaved);
        if (audit.status === 'mismatch') failures.push(`${label} step ${step}: ${audit.detail}`);
      });
    }
    expect(failures).toEqual([]);
  });

  it('严一档规则只对 legacy 序列放宽：现行序列里伪造的 +3 仍拒绝', () => {
    const ledger = byName('ii-150000-aql4-two-accepted');
    // 现行代码对同样两批给 0 分;把 v1.32 的得分搬进带序列号的现行账本 → 不一致。
    let status = freshSwitchStatus();
    status = recordInspection(status, { lot: 150000, level: 'II', aql: 4.0, regime: 'percent', nonconforming: 0, batchId: 'L1', inspector: 'QA', inspectedAt: '2026-07-15T08:00:00Z' });
    status = recordInspection(status, { lot: 150000, level: 'II', aql: 4.0, regime: 'percent', nonconforming: 2, batchId: 'L2', inspector: 'QA', inspectedAt: '2026-07-15T09:00:00Z' });
    expect(status.switchingScore).toBe(0);
    const forged = {
      ...status, switchingScore: 6,
      records: status.records.map((record, index) => ({ ...record, switchingScoreAfter: [3, 6][index] })),
    };
    expect(auditAqlLedger(forged).status).toBe('mismatch');
    expect(ledger.records).toHaveLength(2);
  });

  it('v1.32 严一档规则累计到 30 分并转放宽的账本接受;放宽后的得分仍按记录核对', () => {
    const ledger = byName('ii-150000-aql4-to-reduced');
    const last = lastOf(ledger.snapshots);
    const raw = rawAt(ledger, last);
    expect(raw).toMatchObject({ state: 'reduced', switchingScore: 30 });
    const audit = auditAqlLedger(raw);
    expect(audit.status, audit.detail).toBe('legacy');
    expect(audit.notes.join('\n')).toMatch(/9 处按 v1\.32 严一档规则计分/);
    expect(audit.notes.join('\n')).toMatch(/人工状态转移/);
    expect(auditAqlLedger({ ...raw, switchingScore: 33 }).status).toBe('mismatch');
  });
});

describe('B3 收紧 legacy 推定 + 加严/暂停被推定重置时的独立警示', () => {
  let clock = 0;
  const at = () => new Date(Date.UTC(2026, 3, 1) + (clock += 60_000)).toISOString();
  const b = (s: SwitchStatus, d: number, id: string) => recordInspection(s, {
    lot: 1000, level: 'II', aql: 1.0, regime: 'percent', nonconforming: d, batchId: id, inspector: 'QA', inspectedAt: at(),
  });
  const payload = (sw: unknown) => ({
    aqlLot: 1000, aqlLevel: 'II', aqlAQL: 1.0, aqlRegime: 'percent', aqlMethod: 'gb', aqlAcMethod: 'gb',
    aqlSwitch: JSON.parse(JSON.stringify(sw)),
  });
  const tightened = () => b(b(freshSwitchStatus(), 5, 'T1'), 5, 'T2');

  it('复审绕过:现行账本删光 sequenceId 冒充 v1.32,加严 → 正常 被拒(记录带 v1.34 之后的字段)', () => {
    const s = tightened();
    expect(s.state).toBe('tightened');
    const raw = JSON.parse(JSON.stringify(s));
    delete raw.sequenceId;
    raw.records = raw.records.map(({ sequenceId: _drop, ...rest }: Record<string, unknown>) => rest);
    Object.assign(raw, { state: 'normal', switchingScore: 0, tightenedRejections: 0, sinceSwitch: [], history: [] });
    const audit = auditAqlLedger(raw);
    expect(audit.status).toBe('mismatch');
    expect(audit.detail).toMatch(/v1\.34 之后才有的字段/);
    expect(projectStoreValidationError('qp-aql-state-v1', payload(raw))).toMatch(/记录链/);
    // 不篡改状态、只删序列号同样是「非任何正式版本写出的形态」
    const stripped = JSON.parse(JSON.stringify(s));
    delete stripped.sequenceId;
    stripped.records.forEach((record: Record<string, unknown>) => { delete record.sequenceId; });
    expect(auditAqlLedger(stripped).status).toBe('mismatch');
  });

  it('顶层与记录的序列号形态必须一致(混合形态按损坏处理)', () => {
    const s = tightened();
    const topless = JSON.parse(JSON.stringify(s));
    delete topless.sequenceId;
    expect(auditAqlLedger(topless).status).toBe('mismatch');
    // 真实 v1.32 载荷(无任何序列号)本身接受;只给顶层补上序列号、记录仍是 v1.32 原文 → 任何版本都写不出 → 拒绝
    const ledger = byName('tightened-then-setaql-reset');
    const raw = rawAt(ledger, lastOf(ledger.snapshots));
    expect(auditAqlLedger(raw).status).toBe('legacy');
    expect(auditAqlLedger({ ...raw, sequenceId: AQL_LEGACY_SEQUENCE_ID }).status).toBe('mismatch');
  });

  it('真实 v1.32 加严中改 AQL 的重置:接受但给出「加严被推定重置、无法核对」独立警示', () => {
    const ledger = byName('tightened-then-setaql-reset');
    const afterReset = ledger.snapshots[2];
    expect(afterReset.op).toBe('setAql');
    for (const snap of ledger.snapshots.slice(2)) {
      const raw = rawAt(ledger, snap);
      const audit = auditAqlLedger(raw);
      expect(audit.status, audit.detail).toBe('legacy');
      expect(audit.alerts.join('\n')).toMatch(/由旧版本推定从加严检验.*重置为正常检验，无法核对/);
      // 回写形态同样带警示
      expect(auditAqlLedger(normalizeSwitchStatus(raw)).alerts).toHaveLength(1);
    }
    // 重置前(仍在加严)没有警示
    const before = auditAqlLedger(rawAt(ledger, ledger.snapshots[1]));
    expect(before.alerts).toEqual([]);
  });

  it('按 v1.32 形态整体伪造(连 regime/处置一起删)仍可能被接受——必须带警示，专项报告数据携带', () => {
    const s = tightened();
    const raw = JSON.parse(JSON.stringify(s));
    delete raw.sequenceId;
    raw.records.forEach((record: Record<string, unknown>) => {
      delete record.sequenceId; delete record.regime; delete record.nonconformingDisposition;
    });
    Object.assign(raw, { state: 'normal', switchingScore: 0, tightenedRejections: 0, sinceSwitch: [], history: [] });
    const audit = auditAqlLedger(raw);
    expect(audit.status).toBe('legacy');
    expect(audit.alerts).toHaveLength(1);
    const report = buildAqlReportData(1000, 'II', 1.0, normalizeSwitchStatus(raw), 'percent');
    expect(report.ledgerAudit.alerts).toEqual(audit.alerts);
  });

  it('现行账本的合法路径不产生警示', () => {
    let s = tightened();
    for (let i = 0; i < 5; i += 1) s = b(s, 0, `A${i}`);
    expect(s.state).toBe('normal');
    for (let i = 0; i < 10; i += 1) s = b(s, 0, `N${i}`);
    s = setSwitchConditions(s, { productionSteady: true, reducedApproved: true }, { operator: 'x', at: at() });
    expect(auditAqlLedger(s)).toMatchObject({ status: 'verified', alerts: [] });
  });
});
