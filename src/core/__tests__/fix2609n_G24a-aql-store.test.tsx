/**
 * fix2609n · G24a-aql —— store / 专项报告部分。全部走真实生产模块，每个用例 vi.resetModules 后重新加载
 * appStore,模拟一次独立启动。
 *
 * A1:v1.32 真实「加严中改 AQL」重置账本经 prefs v2 直升 HEAD 后，在正常检验中 setAql 改一次 AQL,
 *     legacy 推定重置警示不得消失(页面/专项报告同源于 auditAqlLedger)，重启后仍在。
 * A2:独立账本 qp-aql-state-v1 有效时，旧 prefs 内嵌 AQL 子集校验失败不再写隔离区(不会用到它，
 *     只是噪声、挤占配额);独立键缺失、确定要回退到 prefs 内嵌账本时仍 fail-closed 并隔离原文。
 * @vitest-environment jsdom
 */
import { act, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditAqlLedger, freshSwitchStatus, recordInspection, type SwitchStatus } from '..';

const PREFS_KEY = 'qp-prefs-v1';
const AQL_KEY = 'qp-aql-state-v1';
const QUARANTINE_KEY = 'qp-quarantine-v1';

interface Snapshot { params: { lot: number; level: string; aql: number }; top: Record<string, unknown>; history: string; sinceSwitch: string; recordCount: number }
interface Ledger { name: string; records: unknown[]; snapshots: Snapshot[] }
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/aql-v1.32-ledgers.json'), 'utf8')) as { cases: Ledger[] };

let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 3) + (clock += 60_000)).toISOString();
const b = (s: SwitchStatus, d: number, id: string) => recordInspection(s, {
  lot: 1000, level: 'II', aql: 1.0, regime: 'percent', nonconforming: d, batchId: id, inspector: 'QA', inspectedAt: at(),
});

/** 复审复现：合法加严账本改成「正常/28」,放进旧 prefs 内嵌位置。 */
function tamperedPrefs(chartStyle = '经典'): string {
  const legit = b(b(freshSwitchStatus(), 5, 'T1'), 5, 'T2');
  const tampered = { ...legit, state: 'normal', switchingScore: 28, tightenedRejections: 0, sinceSwitch: [] };
  return JSON.stringify({
    state: { chartStyle, aqlLot: 1000, aqlLevel: 'II', aqlAQL: 1.0, aqlRegime: 'percent', aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: tampered },
    version: 3,
  });
}
const quarantine = () => JSON.parse(localStorage.getItem(QUARANTINE_KEY) ?? '{}') as Record<string, { raw: string; detail: string }>;

async function boot() {
  const appStore = await import('../../store/appStore');
  const report = await import('../../platform/activeAnalysisReport');
  return { appStore, report };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('A1 v1.32 重置账本升级后正常改一次 AQL:警示不消失', () => {
  it('prefs v2 直升 → setAql 开启新序列 → 审计仍 legacy、专项报告警示首行仍在，重启后依旧', async () => {
    const ledger = fixture.cases.find((item) => item.name === 'tightened-then-setaql-reset')!;
    const snap = ledger.snapshots[ledger.snapshots.length - 1];
    const aqlSwitch = {
      ...snap.top, history: snap.history.split(''), sinceSwitch: snap.sinceSwitch.split(''),
      records: ledger.records.slice(0, snap.recordCount),
    };
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      state: { aqlLot: snap.params.lot, aqlLevel: snap.params.level, aqlAQL: snap.params.aql, aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch },
      version: 2,
    }));
    const { appStore, report } = await boot();
    expect(appStore.useApp.getState().aqlLedgerFault).toBeNull();
    const before = auditAqlLedger(appStore.useApp.getState().aqlSwitch);
    expect(before.alerts).toHaveLength(1);

    act(() => appStore.useApp.getState().setAql({ aqlAQL: 2.5 }));
    const changed = appStore.useApp.getState().aqlSwitch;
    expect(changed.sequenceId).not.toBe('sequence-legacy-v2');
    const after = auditAqlLedger(changed);
    expect(after.status, after.detail).toBe('legacy');
    expect(after.alerts).toEqual(before.alerts);
    act(() => appStore.useApp.setState({ page: 'aql' }));
    expect(report.buildActiveAnalysisReport()!.warnings[0]).toMatch(/^【责任账本警示】检验状态由旧版本推定从加严检验/);

    // 独立账本落盘后重启：仍通过闸门、警示仍在
    vi.resetModules();
    const second = await boot();
    expect(second.appStore.useApp.getState().aqlLedgerFault).toBeNull();
    expect(second.appStore.useApp.getState().aqlAQL).toBe(2.5);
    expect(auditAqlLedger(second.appStore.useApp.getState().aqlSwitch).alerts).toHaveLength(1);
  });
});

describe('A2 prefs 内嵌 AQL 子集的隔离时机', () => {
  it('独立键有效 + prefs 内嵌篡改：账本不受限、其余偏好照常恢复、隔离区不写 qp-prefs-v1', async () => {
    const legit = b(freshSwitchStatus(), 0, 'OK1');
    localStorage.setItem(AQL_KEY, JSON.stringify({
      aqlLot: 1000, aqlLevel: 'II', aqlAQL: 1.0, aqlRegime: 'percent', aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: legit,
    }));
    localStorage.setItem(PREFS_KEY, tamperedPrefs('现代'));
    const { appStore } = await boot();
    const s = appStore.useApp.getState();
    expect(s.aqlLedgerFault).toBeNull();
    expect(s.aqlSwitch.records).toHaveLength(1);
    expect(s.chartStyle).toBe('现代');
    expect(quarantine()).not.toHaveProperty(PREFS_KEY);
    // 独立账本原样可用：可继续登记批次
    expect(() => s.setAqlSwitch(b(s.aqlSwitch, 0, 'OK2'))).not.toThrow();
  });

  it('独立键缺失 + prefs 内嵌篡改：仍 fail-closed,原文进隔离区，不写独立键', async () => {
    const raw = tamperedPrefs();
    localStorage.setItem(PREFS_KEY, raw);
    const { appStore } = await boot();
    expect(appStore.useApp.getState().aqlLedgerFault).toBe('quarantined');
    expect(appStore.useApp.getState().aqlSwitch.records).toHaveLength(0);
    expect(quarantine()[PREFS_KEY]?.raw).toBe(raw);
    expect(quarantine()[PREFS_KEY]?.detail).toMatch(/旧偏好内嵌的 AQL 责任账本未通过校验/);
    expect(localStorage.getItem(AQL_KEY)).toBeNull();
  });

  it('独立键缺失 + prefs 内嵌篡改 + 隔离区写入失败：受限(unpreserved)且 prefs 原文不被覆盖', async () => {
    const raw = tamperedPrefs();
    localStorage.setItem(PREFS_KEY, raw);
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === QUARANTINE_KEY) throw new DOMException('quota', 'QuotaExceededError');
      return setItem.call(this, key, value);
    });
    const { appStore } = await boot();
    expect(appStore.useApp.getState().aqlLedgerFault).toBe('unpreserved');
    act(() => appStore.useApp.getState().setChartStyle('现代'));
    // 隔离失败时 prefs 原文(坏证据)原地保留，不被偏好重写顶掉
    expect(localStorage.getItem(PREFS_KEY)).toBe(raw);
    expect(localStorage.getItem(AQL_KEY)).toBeNull();
  });
});
