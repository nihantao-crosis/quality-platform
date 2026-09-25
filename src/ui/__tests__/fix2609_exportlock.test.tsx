/**
 * fix2609 G5-exportlock 回归：
 * - GAP-7-16：「清除数据」与进行中的项目导出(一致性快照)互斥，两侧都给出明确原因；
 * - STORE-09：AQL 责任账本损坏(已隔离)后，AQL 页明确阻断登记并指引恢复，
 *   存储失败提示区分「损坏」与「配额不足」，不再把损坏误报为空间问题。
 *
 * 每个用例都 vi.resetModules 后重新加载真实生产模块，模拟一次独立启动；
 * 数据库使用与桌面适配器同形态的替身(带 readSnapshot，对应 db_read_snapshot)。
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

async function loadApp() {
  const adapter = await import('../../platform/adapter');
  const appStore = await import('../../store/appStore');
  const project = await import('../../platform/project');
  const { default: App } = await import('../../App');
  return { adapter, appStore, project, App };
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

describe('GAP-7-16 清除数据 × 项目导出互斥', () => {
  it('导出停在 readSnapshot 期间点两次「清除数据」：清库被拒绝、SQLite 与浏览器数据原样保留，导出随后成功', async () => {
    const { adapter, appStore, project, App } = await loadApp();
    const snapshot = deferred<DatasetSnapshot>();
    const clear = vi.fn(async (opId: string) => ({ opId, committed: true as const, removed: 1 }));
    const readSnapshot = vi.fn(() => snapshot.promise);
    adapter.platform.datasetDb = desktopLikeDb({ clear, readSnapshot });
    const specs = '{"直径":{"lsl":24.9,"tgt":25,"usl":25.1}}';
    localStorage.setItem('qp-specs-v1', specs);

    render(<App />);
    act(() => appStore.useApp.setState({ modal: 'options', busyOverlay: null, toast: null }));

    const exporting = project.buildProjectJsonFull('1.43.0');
    await waitFor(() => expect(readSnapshot).toHaveBeenCalledOnce());
    expect(appStore.isProjectExportInFlight()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '清除数据并恢复演示' }));
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认彻底清除' }));

    // 清库侧：弹窗内常驻说明 + toast，且没有进入任何清库步骤
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('项目备份正在生成'));
    expect(appStore.useApp.getState().toast).toContain('项目备份正在生成');
    expect(appStore.useApp.getState().busyOverlay).toBeNull();
    expect(appStore.useApp.getState().modal).toBe('options');
    expect(clear).not.toHaveBeenCalled();
    expect(localStorage.getItem('qp-specs-v1')).toBe(specs);
    // 被拒后需要重新二次确认，不能残留「已武装」状态
    expect(screen.getByRole('button', { name: '清除数据并恢复演示' })).toBeTruthy();

    snapshot.resolve({ revision: 7, datasets: [] });
    const text = await exporting;
    expect(JSON.parse(text).stores['qp-specs-v1']).toBe(specs);
    expect(appStore.isProjectExportInFlight()).toBe(false);

    // 导出结束后同一入口恢复可用
    fireEvent.click(screen.getByRole('button', { name: '清除数据并恢复演示' }));
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认彻底清除' }));
    await waitFor(() => expect(clear).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(appStore.useApp.getState().busyOverlay).toBeNull();
      expect(appStore.useApp.getState().modal).toBeNull();
    });
    expect(localStorage.getItem('qp-specs-v1')).toBeNull();
  });

  it('清库进行中发起项目导出：导出在取快照前 fail-closed 并说明真实原因，清库完成后可再次导出', async () => {
    const { adapter, appStore, project, App } = await loadApp();
    const clearing = deferred<{ opId: string; committed: true; removed: number }>();
    let clearOpId = '';
    const clear = vi.fn((opId: string) => { clearOpId = opId; return clearing.promise; });
    const readSnapshot = vi.fn(async () => ({ revision: 1, datasets: [] }));
    adapter.platform.datasetDb = desktopLikeDb({ clear, readSnapshot });

    render(<App />);
    act(() => appStore.useApp.setState({ modal: 'options', busyOverlay: null, toast: null }));
    fireEvent.click(screen.getByRole('button', { name: '清除数据并恢复演示' }));
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认彻底清除' }));
    await waitFor(() => expect(clear).toHaveBeenCalledOnce());

    await expect(project.buildProjectJsonFull('1.43.0')).rejects.toThrow('正在清除本地数据，项目未导出');
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(appStore.isProjectExportInFlight()).toBe(false);

    clearing.resolve({ opId: clearOpId, committed: true, removed: 0 });
    await waitFor(() => expect(appStore.useApp.getState().busyOverlay).toBeNull());
    await expect(project.buildProjectJsonFull('1.43.0')).resolves.toContain('"vault"');
    expect(readSnapshot).toHaveBeenCalledOnce();
  });

  it('导出标记在 buildProjectJsonFull 同步阶段即建立，覆盖 dataStore 冲刷 vault 写入的异步窗口', async () => {
    const { adapter, appStore, project } = await loadApp();
    // 与生产入口一致：dataStore 依赖 appStore，appStore 的导出钩子必然先于 dataStore 的异步冲刷注册
    await import('../../store/dataStore');
    adapter.platform.datasetDb = desktopLikeDb({});
    const exporting = project.buildProjectJsonFull('1.43.0');
    expect(appStore.isProjectExportInFlight()).toBe(true);
    expect(() => appStore.beginLocalDataClear()).toThrow('项目备份正在生成');
    await exporting;
    expect(appStore.isProjectExportInFlight()).toBe(false);
    const release = appStore.beginLocalDataClear();
    expect(() => appStore.beginLocalDataClear()).toThrow('本地数据清除已在进行');
    release();
    release(); // 幂等
    appStore.beginLocalDataClear()();
  });
});

/** 版本不兼容构造的损坏账本：合法账本 + 白名单外的新字段(新版写入/旧版读取)。 */
function futureLedger(): string {
  return JSON.stringify({
    aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1, aqlRegime: 'percent', aqlMethod: 'gb', aqlAcMethod: 'gb',
    aqlSwitch: freshSwitchStatus(),
    aqlFutureField: true,
  });
}

function fillBatch(batchId: string) {
  fireEvent.change(screen.getByLabelText('批次号'), { target: { value: batchId } });
  fireEvent.change(screen.getByLabelText('检验人'), { target: { value: '张检-001' } });
  fireEvent.change(screen.getByLabelText('实际不合格品数'), { target: { value: '0' } });
}

describe('STORE-09 AQL 账本损坏(已隔离)期间的登记与提示', () => {
  it('AQL 页常驻说明并阻断登记，store 层同样拒绝写入批次，账本原文保留', async () => {
    const corrupt = futureLedger();
    localStorage.setItem('qp-aql-state-v1', corrupt);
    const { appStore, App } = await loadApp();
    const { recordInspection } = await import('../../core');
    const quarantine = JSON.parse(localStorage.getItem('qp-quarantine-v1') ?? '{}') as Record<string, unknown>;
    expect(Object.keys(quarantine)).toContain('qp-aql-state-v1');
    expect(appStore.useApp.getState().aqlLedgerFault).toBe('quarantined');

    act(() => appStore.useApp.setState({ page: 'aql', modal: null, toast: null }));
    render(<App />);
    const banner = screen.getAllByRole('alert').find((el) => el.textContent?.includes('AQL 责任账本已损坏'));
    expect(banner?.textContent).toContain('批次登记已暂停');
    expect(banner?.textContent).toContain('文件 → 打开');
    expect(banner?.textContent).toContain('清除数据并恢复演示');

    fillBatch('LOT-CORRUPT-01');
    const submit = screen.getByRole('button', { name: '记录本批并执行转移判定' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(appStore.useApp.getState().aqlSwitch.records).toHaveLength(0);

    // 绕过 UI 直接调用 store 也不能把追溯记录只写进内存
    const s = appStore.useApp.getState();
    const next = recordInspection(s.aqlSwitch, {
      lot: s.aqlLot, level: s.aqlLevel, aql: s.aqlAQL, regime: s.aqlRegime,
      nonconforming: 0, batchId: 'LOT-DIRECT', inspector: '张检-001', originalInspection: true,
    });
    expect(() => s.setAqlSwitch(next)).toThrow('AQL 责任账本已损坏');
    expect(appStore.useApp.getState().aqlSwitch.records).toHaveLength(0);
    expect(localStorage.getItem('qp-aql-state-v1')).toBe(corrupt);
  });

  it('损坏期间修改方案参数：提示指向「账本损坏」而非「释放空间」，完整导出仍按原设计 fail-closed', async () => {
    localStorage.setItem('qp-aql-state-v1', futureLedger());
    const { appStore, project } = await loadApp();
    act(() => appStore.useApp.setState({ toast: null }));
    act(() => appStore.useApp.getState().setAql({ aqlLot: 1800 }));
    const toast = appStore.useApp.getState().toast ?? '';
    expect(toast).toContain('AQL 责任账本已损坏');
    expect(toast).not.toContain('释放空间');
    await expect(project.buildProjectJsonFull('1.43.0')).rejects.toThrow('AQL 责任账本已损坏（原文已复制到隔离区）');
  });

  it('隔离区写入失败时的说明不建议清除数据(那会销毁仅存原文)', async () => {
    localStorage.setItem('qp-aql-state-v1', futureLedger());
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('qp-quarantine-v1')) throw new DOMException('quota', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });
    const { appStore, App } = await loadApp();
    vi.mocked(Storage.prototype.setItem).mockRestore();
    expect(appStore.useApp.getState().aqlLedgerFault).toBe('unpreserved');
    act(() => appStore.useApp.setState({ page: 'aql', modal: null }));
    render(<App />);
    const banner = screen.getAllByRole('alert').find((el) => el.textContent?.includes('AQL 责任账本已损坏'));
    expect(banner?.textContent).toContain('请勿清除数据');
    expect(banner?.textContent).not.toContain('清除数据并恢复演示');
  });

  it('另一窗口写入损坏账本后本窗口立即进入受限状态', async () => {
    const { appStore } = await loadApp();
    expect(appStore.useApp.getState().aqlLedgerFault).toBeNull();
    const corrupt = futureLedger();
    localStorage.setItem('qp-aql-state-v1', corrupt);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'qp-aql-state-v1', newValue: corrupt, storageArea: localStorage })); });
    expect(appStore.useApp.getState().aqlLedgerFault).toBe('quarantined');
    expect(localStorage.getItem('qp-aql-state-v1')).toBe(corrupt);
  });

  it('按指引「清除业务数据」后受限状态解除，可以正常登记并落盘', async () => {
    localStorage.setItem('qp-aql-state-v1', futureLedger());
    const { appStore, App } = await loadApp();
    act(() => appStore.clearAqlBusinessState());
    expect(appStore.useApp.getState().aqlLedgerFault).toBeNull();
    act(() => appStore.useApp.setState({ page: 'aql', modal: null, aqlLot: 2000 }));
    render(<App />);
    expect(screen.queryAllByRole('alert').some((el) => el.textContent?.includes('AQL 责任账本已损坏'))).toBe(false);
    fillBatch('LOT-OK-01');
    const submit = screen.getByRole('button', { name: '记录本批并执行转移判定' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(appStore.useApp.getState().aqlSwitch.records).toHaveLength(1);
    const persisted = JSON.parse(localStorage.getItem('qp-aql-state-v1') ?? '{}') as { aqlSwitch?: { records?: unknown[] } };
    expect(persisted.aqlSwitch?.records).toHaveLength(1);
  });

  it('配额不足(非损坏)时提示如实说明：项目导出会携带内存中的最新账本', async () => {
    const { appStore, project } = await loadApp();
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'qp-aql-state-v1') throw new DOMException('quota', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });
    act(() => appStore.useApp.setState({ toast: null }));
    act(() => appStore.useApp.getState().setAql({ aqlLot: 1500 }));
    const toast = appStore.useApp.getState().toast ?? '';
    expect(toast).toContain('释放空间');
    expect(toast).not.toContain('已损坏');
    expect(toast).not.toContain('项目导出会在安全落盘前阻止');
    const text = await project.buildProjectJsonFull('1.43.0');
    expect(JSON.parse(JSON.parse(text).stores['qp-aql-state-v1']).aqlLot).toBe(1500);
  });
});
