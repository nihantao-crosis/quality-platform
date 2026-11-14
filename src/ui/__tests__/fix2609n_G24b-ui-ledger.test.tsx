/**
 * fix2609n · G24b-ui B2:HEAD 的记录链审计会隔离三类真实历史账本(v1.32/v1.33 表 2-C 已更正格上的放宽记录、
 * 同期全检批有不合格品却未记处置、v1.36–v1.42.4 AQL 0.025 档丢 S 码记录)。兼容口径待负责人拍板,本批只做
 * 文档与横幅:README「AQL 责任账本记录链核对」小节与 AQL 页锁定横幅点名这三类形态与不丢账本的恢复路径,
 * 文案同源(AQL_LEDGER_KNOWN_LEGACY_LOCKS)。
 *
 * 横幅用真实启动路径构造 fault 态:写入损坏账本 → vi.resetModules 后重新加载真实 store → 渲染 AQL 页。
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshSwitchStatus } from '../../core/aqlSwitch';
import { AQL_LEDGER_KNOWN_LEGACY_LOCKS } from '../pages/Aql';

const readme = readFileSync('README.md', 'utf8');

function aqlLedgerSubsection(): string {
  const heading = readme.split('\n').find((line) => line.startsWith('### ') && line.includes('AQL 责任账本记录链核对'));
  expect(heading).toBeDefined();
  const start = readme.indexOf(heading!);
  const next = readme.indexOf('\n### ', start + heading!.length);
  return readme.slice(start, next < 0 ? undefined : next);
}

function corruptLedger(): string {
  return JSON.stringify({
    aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1, aqlRegime: 'percent', aqlMethod: 'gb', aqlAcMethod: 'gb',
    aqlSwitch: freshSwitchStatus(),
    aqlFutureField: true,
  });
}

function failQuarantineWrites() {
  const realSetItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.startsWith('qp-quarantine-v1')) throw new DOMException('quota', 'QuotaExceededError');
    return realSetItem.call(this, key, value);
  });
}

async function loadAqlPage() {
  const appStore = await import('../../store/appStore');
  const { Aql } = await import('../pages/Aql');
  const { chartTokens } = await import('../tokens');
  return { appStore, Aql, T: chartTokens('经典', true) };
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

describe('B2 已知旧形态说明:文案常量', () => {
  it('点名三类形态、触发条件、后果与不丢账本的恢复路径,并注明兼容口径待定', () => {
    const text = AQL_LEDGER_KNOWN_LEGACY_LOCKS;
    expect(text).toMatch(/v1\.32/);
    expect(text).toContain('表 2-C');
    expect(text).toContain('放宽检验');
    expect(text).toMatch(/全检.*不合格品.*未记录处置/);
    expect(text).toContain('AQL 0.025');
    expect(text).toContain('字码 S');
    expect(text).toContain('v1.42.4');
    expect(text).toContain('待');
    // 如实说明:含这类账本的备份在本版同样导入不了,但备份里原文完整
    expect(text).toMatch(/升级前.*备份/);
    expect(text).toMatch(/导入.*拒绝/);
    expect(text).toContain('原文');
  });
});

describe('B2 README 与横幅同源', () => {
  it('README「AQL 责任账本记录链核对」小节原样包含已知形态说明,并提示 AQL 0.025 / v1.32 时期账本升级前先备份', () => {
    const section = aqlLedgerSubsection();
    expect(section).toContain(AQL_LEDGER_KNOWN_LEGACY_LOCKS);
    const upgrade = section.split('\n').find((line) => line.startsWith('- **升级建议'));
    expect(upgrade).toBeDefined();
    expect(upgrade).toMatch(/AQL 0\.025.*v1\.32|v1\.32.*AQL 0\.025/);
    expect(upgrade).toContain('备份');
  });

  it('quarantined:锁定横幅含已知形态与恢复路径', async () => {
    localStorage.setItem('qp-aql-state-v1', corruptLedger());
    const { appStore, Aql, T } = await loadAqlPage();
    expect(appStore.useApp.getState().aqlLedgerFault).toBe('quarantined');
    render(<Aql T={T} />);
    const banner = screen.getAllByRole('alert').find((a) => (a.textContent ?? '').includes('AQL 责任账本已损坏'));
    expect(banner).toBeDefined();
    expect(banner!.textContent).toContain(AQL_LEDGER_KNOWN_LEGACY_LOCKS);
    expect(banner!.textContent).toContain('纸质记录');
  });

  it('unpreserved(隔离区写入失败):同样点名已知形态,且仍劝阻清除数据', async () => {
    localStorage.setItem('qp-aql-state-v1', corruptLedger());
    failQuarantineWrites();
    const { appStore, Aql, T } = await loadAqlPage();
    vi.mocked(Storage.prototype.setItem).mockRestore();
    expect(appStore.useApp.getState().aqlLedgerFault).toBe('unpreserved');
    render(<Aql T={T} />);
    const banner = screen.getAllByRole('alert').find((a) => (a.textContent ?? '').includes('AQL 责任账本已损坏'));
    expect(banner!.textContent).toContain(AQL_LEDGER_KNOWN_LEGACY_LOCKS);
    expect(banner!.textContent).toContain('请勿清除数据');
  });
});
