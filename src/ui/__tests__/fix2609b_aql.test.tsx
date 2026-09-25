/**
 * fix2609b G5b-aql 回归(第 1 批对抗复审遗留)：
 * - M5 / STORE-09：AQL 责任账本损坏/被隔离时，内存里只有默认空账本(正常检验、0 条记录)。
 *   AQL 专项报表若照常生成，就是一份「看似正常的空追溯账本」——与不放行 .qproj 导出
 *   同理，属于伪造可追溯证据，必须拒绝生成；AQL 页横幅不得把 AQL 报表列为留底手段，
 *   并提示「其他窗口已恢复时请刷新本窗口」(受限状态按隔离语义不会原地解除)。
 * - GAP-7-16 复审 P3：清库被导出拒绝后的提示不得在导出结束、重新武装时残留；
 *   拒绝文案不能依赖取消保存时永远不会出现的「项目已保存」提示，且两处文案统一；
 *   清库已提交后的收尾若抛错，遮罩与 clearing 必须复位，不得永久卡住界面。
 *
 * 每个用例 vi.resetModules 后重新加载真实生产模块，模拟一次独立启动。
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatasetDb, DatasetSnapshot } from '../../platform/adapter';
import { freshSwitchStatus } from '../../core/aqlSwitch';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function desktopLikeDb(overrides: Partial<DatasetDb>): DatasetDb {
  return {
    async put() {},
    async get() { return null; },
    async list() { return []; },
    async remove() { return false; },
    async clear(opId) { return { opId, committed: true, removed: 0 }; },
    async clearStatus() { return null; },
    async stats() { return { count: 0, total_bytes: 0, path: ':memory:' }; },
    async readSnapshot() { return { revision: 1, datasets: [] }; },
    ...overrides,
  };
}

/** 版本不兼容构造的损坏账本：合法账本 + 白名单外的新字段(新版写入/旧版读取)。 */
function futureLedger(): string {
  return JSON.stringify({
    aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1, aqlRegime: 'percent', aqlMethod: 'gb', aqlAcMethod: 'gb',
    aqlSwitch: freshSwitchStatus(),
    aqlFutureField: true,
  });
}

/** 让隔离区写入失败，构造 aqlLedgerFault='unpreserved' 的启动。 */
function failQuarantineWrites() {
  const realSetItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.startsWith('qp-quarantine-v1')) throw new DOMException('quota', 'QuotaExceededError');
    return realSetItem.call(this, key, value);
  });
}

async function loadApp() {
  const adapter = await import('../../platform/adapter');
  const appStore = await import('../../store/appStore');
  const project = await import('../../platform/project');
  const report = await import('../../platform/activeAnalysisReport');
  const { default: App } = await import('../../App');
  return { adapter, appStore, project, report, App };
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

describe('M5 / STORE-09 账本损坏时 AQL 专项报表拒绝生成', () => {
  it('健康账本：AQL 页照常生成专项报表(基线)', async () => {
    const { appStore, report } = await loadApp();
    expect(appStore.useApp.getState().aqlLedgerFault).toBeNull();
    act(() => appStore.useApp.setState({ page: 'aql' }));
    expect(report.buildActiveAnalysisReport()?.kind).toBe('aql');
    expect(report.buildActiveAnalysisExport().report?.kind).toBe('aql');
  });

  it('aqlLedgerFault=quarantined：专项报表与导出载荷都被拒绝，不产出「0 条记录」的空账本', async () => {
    const corrupt = futureLedger();
    localStorage.setItem('qp-aql-state-v1', corrupt);
    const { appStore, report } = await loadApp();
    expect(appStore.useApp.getState().aqlLedgerFault).toBe('quarantined');
    // 损坏期间内存里正是默认空账本：若照常生成，报表会显示「正常检验、尚未记录」
    expect(appStore.useApp.getState().aqlSwitch.records).toHaveLength(0);
    act(() => appStore.useApp.setState({ page: 'aql' }));
    expect(() => report.buildActiveAnalysisReport()).toThrow('AQL 责任账本已损坏/被隔离，本报表无法反映历史批次记录，已拒绝生成');
    expect(() => report.buildActiveAnalysisExport()).toThrow('请先按 AQL 页横幅恢复账本');
    // 拒绝生成不触碰账本原文
    expect(localStorage.getItem('qp-aql-state-v1')).toBe(corrupt);
  });

  it('隔离区写入失败(unpreserved)同样拒绝', async () => {
    localStorage.setItem('qp-aql-state-v1', futureLedger());
    failQuarantineWrites();
    const { appStore, report } = await loadApp();
    vi.mocked(Storage.prototype.setItem).mockRestore();
    expect(appStore.useApp.getState().aqlLedgerFault).toBe('unpreserved');
    act(() => appStore.useApp.setState({ page: 'aql' }));
    expect(() => report.buildActiveAnalysisReport()).toThrow('已拒绝生成');
  });

  it('其他页面的专项报表不受 AQL 账本损坏影响(横幅仍建议用导出报表给工作表与分析留底)', async () => {
    localStorage.setItem('qp-aql-state-v1', futureLedger());
    const { appStore, report } = await loadApp();
    act(() => appStore.useApp.setState({ page: 'summary' }));
    expect(report.buildActiveAnalysisReport()?.kind).toBe('summary');
  });

  it('从导出弹窗点「导出」：弹出中文拒绝原因，不产出文件', async () => {
    localStorage.setItem('qp-aql-state-v1', futureLedger());
    const { adapter, appStore, App } = await loadApp();
    const exportFile = vi.fn(async () => 'should-not-happen');
    adapter.platform.exportFile = exportFile;
    render(<App />);
    act(() => appStore.useApp.setState({ page: 'aql', modal: 'export', toast: null, exportFmt: 'pdf' }));
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await waitFor(() => expect(appStore.useApp.getState().toast).toContain('导出失败'));
    expect(appStore.useApp.getState().toast).toContain('AQL 责任账本已损坏/被隔离');
    expect(exportFile).not.toHaveBeenCalled();
  });

  it('AQL 页横幅：写明 AQL 报表不在留底范围内，并提示其他窗口恢复后刷新本窗口', async () => {
    localStorage.setItem('qp-aql-state-v1', futureLedger());
    const { appStore, App } = await loadApp();
    act(() => appStore.useApp.setState({ page: 'aql', modal: null }));
    render(<App />);
    const banner = screen.getAllByRole('alert').find((el) => el.textContent?.includes('AQL 责任账本已损坏'));
    expect(banner?.textContent).toContain('AQL 报表不在留底范围内');
    expect(banner?.textContent).toContain('若已在其他窗口完成恢复，请刷新本窗口');
  });

  it('隔离区写入失败时横幅同样写明 AQL 报表不在留底范围内，且仍不建议清除数据', async () => {
    localStorage.setItem('qp-aql-state-v1', futureLedger());
    failQuarantineWrites();
    const { appStore, App } = await loadApp();
    vi.mocked(Storage.prototype.setItem).mockRestore();
    act(() => appStore.useApp.setState({ page: 'aql', modal: null }));
    render(<App />);
    const banner = screen.getAllByRole('alert').find((el) => el.textContent?.includes('AQL 责任账本已损坏'));
    expect(banner?.textContent).toContain('AQL 报表不在留底范围内');
    expect(banner?.textContent).toContain('请刷新本窗口');
    expect(banner?.textContent).not.toContain('清除数据并恢复演示');
  });
});

describe('GAP-7-16 复审 P3：清库拒绝提示与收尾', () => {
  it('被导出拒绝后，导出结束再次武装时不再残留「项目备份正在生成」提示', async () => {
    const { adapter, appStore, project, App } = await loadApp();
    const snapshot = deferred<DatasetSnapshot>();
    const readSnapshot = vi.fn(() => snapshot.promise);
    adapter.platform.datasetDb = desktopLikeDb({ readSnapshot });
    render(<App />);
    act(() => appStore.useApp.setState({ modal: 'options', busyOverlay: null, toast: null }));

    const exporting = project.buildProjectJsonFull('1.43.0');
    await waitFor(() => expect(readSnapshot).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '清除数据并恢复演示' }));
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认彻底清除' }));
    await waitFor(() => expect(screen.queryAllByRole('alert').some((el) => el.textContent?.includes('项目备份正在生成'))).toBe(true));

    snapshot.resolve({ revision: 3, datasets: [] });
    await exporting;
    // 导出已结束：重新武装(第一次点击)时，旧的拒绝原因必须消失
    fireEvent.click(screen.getByRole('button', { name: '清除数据并恢复演示' }));
    expect(screen.getByRole('button', { name: '再次点击确认彻底清除' })).toBeTruthy();
    expect(screen.queryAllByRole('alert').some((el) => el.textContent?.includes('项目备份正在生成'))).toBe(false);
  });

  it('拒绝文案不依赖「项目已保存」提示(取消保存时永远不会出现)，UI 入口与直接调用口径统一', async () => {
    const { adapter, appStore, project } = await loadApp();
    const optionsModal = await import('../shell/OptionsModal');
    const snapshot = deferred<DatasetSnapshot>();
    adapter.platform.datasetDb = desktopLikeDb({ readSnapshot: vi.fn(() => snapshot.promise) });
    const exporting = project.buildProjectJsonFull('1.43.0');
    let leaseMessage = '';
    try { appStore.beginLocalDataClear(); } catch (error) { leaseMessage = (error as Error).message; }
    let directMessage = '';
    try { await optionsModal.clearDurableBusinessDataAtomically(adapter.platform.datasetDb); } catch (error) { directMessage = (error as Error).message; }
    snapshot.resolve({ revision: 1, datasets: [] });
    await exporting;
    expect(leaseMessage).toContain('项目备份正在生成，本地数据未清除');
    expect(leaseMessage).not.toContain('项目已保存');
    expect(leaseMessage).toContain('保存对话框');
    expect(directMessage).toBe(leaseMessage);
  });

  it('清库已提交后收尾抛错：遮罩与清除中状态复位，并如实提示数据已清除', async () => {
    const { adapter, appStore, App } = await loadApp();
    const dataStore = await import('../../store/dataStore');
    adapter.platform.datasetDb = desktopLikeDb({});
    render(<App />);
    act(() => appStore.useApp.setState({ modal: 'options', busyOverlay: null, toast: null }));
    // 让收尾的 resetDemo 抛错(清库已在 SQLite/浏览器存储两侧提交)
    const realReset = dataStore.useData.getState().resetDemo;
    act(() => dataStore.useData.setState({ resetDemo: () => { throw new Error('界面重置模拟失败'); } }));
    fireEvent.click(screen.getByRole('button', { name: '清除数据并恢复演示' }));
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认彻底清除' }));
    await waitFor(() => expect(appStore.useApp.getState().toast).toContain('数据已清除，但界面重置失败'));
    expect(appStore.useApp.getState().busyOverlay).toBeNull();
    act(() => dataStore.useData.setState({ resetDemo: realReset }));
    // 租约已释放：可再次发起清库
    appStore.beginLocalDataClear()();
  });
});
