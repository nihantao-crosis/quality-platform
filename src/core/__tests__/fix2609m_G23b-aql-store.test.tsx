/**
 * fix2609m · G23b-aql(最终对抗复审 P2)——store / 页面 / 专项报告部分。全部走真实生产模块，
 * 每个用例 vi.resetModules 后重新加载 appStore,模拟一次独立启动。
 *
 * B2:旧 prefs 内嵌账本入口(qp-prefs-v1.state.aqlSwitch,且没有独立 qp-aql-state-v1)必须与独立账本
 *     同口径 fail-closed:受限状态、原文进隔离区、不写 qp-aql-state-v1,且下次启动仍受限。
 * B3:legacy 推定把加严/暂停重置为正常检验时，AQL 页与专项报告(含 html/xlsx 导出)醒目警示。
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshSwitchStatus, recordInspection, type SwitchStatus } from '..';

const PREFS_KEY = 'qp-prefs-v1';
const AQL_KEY = 'qp-aql-state-v1';
const QUARANTINE_KEY = 'qp-quarantine-v1';

interface Snapshot { params: { lot: number; level: string; aql: number }; top: Record<string, unknown>; history: string; sinceSwitch: string; recordCount: number }
interface Ledger { name?: string; records: unknown[]; snapshots: Snapshot[] }
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/aql-v1.32-ledgers.json'), 'utf8')) as { cases: Ledger[] };
const v132Case = (name: string) => {
  const ledger = fixture.cases.find((item) => item.name === name)!;
  const snap = ledger.snapshots[ledger.snapshots.length - 1];
  return {
    params: snap.params,
    aqlSwitch: {
      ...snap.top, history: snap.history.split(''), sinceSwitch: snap.sinceSwitch.split(''),
      records: ledger.records.slice(0, snap.recordCount),
    },
  };
};

let clock = 0;
const at = () => new Date(Date.UTC(2026, 3, 1) + (clock += 60_000)).toISOString();
const b = (s: SwitchStatus, d: number, id: string) => recordInspection(s, {
  lot: 1000, level: 'II', aql: 1.0, regime: 'percent', nonconforming: d, batchId: id, inspector: 'QA', inspectedAt: at(),
});
const tightened = () => b(b(freshSwitchStatus(), 5, 'T1'), 5, 'T2');

/** 复审复现:合法加严账本改成「正常/28」,放进旧 prefs 内嵌位置。 */
function tamperedPrefs(): string {
  const legit = tightened();
  const tampered = { ...legit, state: 'normal', switchingScore: 28, tightenedRejections: 0, sinceSwitch: [] };
  return JSON.stringify({
    state: { chartStyle: '经典', aqlLot: 1000, aqlLevel: 'II', aqlAQL: 1.0, aqlRegime: 'percent', aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: tampered },
    version: 3,
  });
}

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

describe('B2 旧 prefs 内嵌账本入口 fail-closed', () => {
  it('篡改的内嵌账本(无独立键):启动即受限、原文进隔离区、不写 qp-aql-state-v1、报表拒绝生成', async () => {
    const raw = tamperedPrefs();
    localStorage.setItem(PREFS_KEY, raw);
    const { appStore, report } = await boot();
    const s = appStore.useApp.getState();
    expect(s.aqlLedgerFault).toBe('quarantined');
    // 回退当前默认值，绝不把篡改的「正常/28」当作有效账本
    expect(s.aqlSwitch.state).toBe('normal');
    expect(s.aqlSwitch.switchingScore).toBe(0);
    expect(s.aqlSwitch.records).toHaveLength(0);
    expect(localStorage.getItem(AQL_KEY)).toBeNull();
    const quarantine = JSON.parse(localStorage.getItem(QUARANTINE_KEY) ?? '{}') as Record<string, { raw: string }>;
    expect(quarantine[PREFS_KEY]?.raw).toBe(raw);
    act(() => appStore.useApp.setState({ page: 'aql' }));
    expect(() => report.buildActiveAnalysisReport()).toThrow('已拒绝生成');
    // 本会话登记批次同样被拒(不能转放宽、不能写账本)
    expect(localStorage.getItem(AQL_KEY)).toBeNull();
  });

  it('受限期间其他偏好改动重写 prefs 时保留原 AQL 字段 → 下次启动仍受限', async () => {
    localStorage.setItem(PREFS_KEY, tamperedPrefs());
    const first = await boot();
    act(() => first.appStore.useApp.getState().setChartStyle('现代'));
    const rewritten = JSON.parse(localStorage.getItem(PREFS_KEY)!) as { state: Record<string, unknown> };
    expect(rewritten.state.chartStyle).toBe('现代');
    expect((rewritten.state.aqlSwitch as SwitchStatus).switchingScore).toBe(28);
    expect(localStorage.getItem(AQL_KEY)).toBeNull();

    vi.resetModules();
    const second = await boot();
    expect(second.appStore.useApp.getState().aqlLedgerFault).toBe('quarantined');
    expect(second.appStore.useApp.getState().chartStyle).toBe('现代');
    expect(localStorage.getItem(AQL_KEY)).toBeNull();
  });

  it('「清除业务数据」解除受限后，prefs 不再携带坏账本', async () => {
    localStorage.setItem(PREFS_KEY, tamperedPrefs());
    const { appStore } = await boot();
    act(() => appStore.clearAqlBusinessState());
    expect(appStore.useApp.getState().aqlLedgerFault).toBeNull();
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY)!) as { state: Record<string, unknown> };
    expect(prefs.state).not.toHaveProperty('aqlSwitch');
  });

  it('合法的旧 prefs 内嵌账本照常迁出:现行加严账本、v1.32 真实账本(prefs v2)都不受限', async () => {
    const legit = tightened();
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      state: { aqlLot: 1000, aqlLevel: 'II', aqlAQL: 1.0, aqlRegime: 'percent', aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: legit },
      version: 3,
    }));
    const first = await boot();
    expect(first.appStore.useApp.getState().aqlLedgerFault).toBeNull();
    expect(first.appStore.useApp.getState().aqlSwitch.state).toBe('tightened');
    expect(JSON.parse(localStorage.getItem(AQL_KEY)!).aqlSwitch.records).toHaveLength(2);

    localStorage.clear();
    vi.resetModules();
    const v132 = v132Case('ii-150000-aql4-two-accepted');
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      state: { aqlLot: v132.params.lot, aqlLevel: v132.params.level, aqlAQL: v132.params.aql, aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: v132.aqlSwitch },
      version: 2,
    }));
    const second = await boot();
    expect(second.appStore.useApp.getState().aqlLedgerFault).toBeNull();
    expect(second.appStore.useApp.getState().aqlSwitch.switchingScore).toBe(6);
    // 迁出后的独立账本(HEAD 回写形态)再次启动仍然有效
    vi.resetModules();
    const third = await boot();
    expect(third.appStore.useApp.getState().aqlLedgerFault).toBeNull();
    expect(third.appStore.useApp.getState().aqlSwitch.records).toHaveLength(2);
  });
});

describe('B3 legacy 推定重置加严 → 页面与专项报告(含导出)醒目警示', () => {
  const T = { chartStyle: '经典' };

  it('v1.32 真实账本「加严中改 AQL」:AQL 页 role=alert、报告警示首行、html/xlsx 导出都带警示', async () => {
    const v132 = v132Case('tightened-then-setaql-reset');
    localStorage.setItem(AQL_KEY, JSON.stringify({
      aqlLot: v132.params.lot, aqlLevel: v132.params.level, aqlAQL: v132.params.aql,
      aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: v132.aqlSwitch,
    }));
    const { appStore, report } = await boot();
    expect(appStore.useApp.getState().aqlLedgerFault).toBeNull();
    const { Aql } = await import('../../ui/pages/Aql');
    const { chartTokens } = await import('../../ui/tokens');
    render(<Aql T={chartTokens(T.chartStyle as '经典', true)} />);
    const alert = screen.getByRole('alert', { name: '责任账本警示' });
    expect(alert.textContent).toMatch(/由旧版本推定从加严检验.*重置为正常检验，无法核对/);

    act(() => appStore.useApp.setState({ page: 'aql' }));
    const payload = report.buildActiveAnalysisExport().report!;
    expect(payload.kind).toBe('aql');
    expect(payload.warnings[0]).toMatch(/^【责任账本警示】检验状态由旧版本推定从加严检验/);

    const { buildHtmlReport } = await import('../../platform/htmlReport');
    const { useData } = await import('../../store/dataStore');
    const html = buildHtmlReport(useData.getState().model, { lsl: 0, usl: 1, tgt: 0.5 } as never, null, payload);
    expect(html).toContain('【责任账本警示】检验状态由旧版本推定从加严检验');
    const { buildAnalysisXlsxRows } = await import('../../platform/xlsxExport');
    const cells = buildAnalysisXlsxRows(payload).flat().map((cell) => (typeof cell === 'object' ? String(cell.v) : String(cell)));
    expect(cells.some((cell) => cell.startsWith('【责任账本警示】'))).toBe(true);
  });

  it('现行合法账本不出现警示', async () => {
    const legit = tightened();
    localStorage.setItem(AQL_KEY, JSON.stringify({
      aqlLot: 1000, aqlLevel: 'II', aqlAQL: 1.0, aqlRegime: 'percent', aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: legit,
    }));
    const { appStore, report } = await boot();
    const { Aql } = await import('../../ui/pages/Aql');
    const { chartTokens } = await import('../../ui/tokens');
    render(<Aql T={chartTokens('经典', true)} />);
    expect(screen.queryByRole('alert', { name: '责任账本警示' })).toBeNull();
    act(() => appStore.useApp.setState({ page: 'aql' }));
    expect(report.buildActiveAnalysisReport()!.warnings.some((line) => line.includes('责任账本警示'))).toBe(false);
  });
});
