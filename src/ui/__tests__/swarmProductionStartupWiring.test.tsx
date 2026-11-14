/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bootstrapApplication = vi.fn();
const acquireAppWriterLease = vi.fn();
const recoverPendingProjectImport = vi.fn();
const recoverPendingClearOperation = vi.fn();
const hydrateLoadedDataAfterProjectRecovery = vi.fn();
const createRoot = vi.fn(() => ({ render: vi.fn() }));
const DummyApp = () => null;

vi.mock('../../bootstrap', () => ({ bootstrapApplication }));
vi.mock('../../platform/singleWriter', () => ({ acquireAppWriterLease }));
vi.mock('../../platform/project', () => ({ recoverPendingProjectImport }));
vi.mock('../../platform/clearRecovery', () => ({ recoverPendingClearOperation }));
vi.mock('../../store/dataStore', () => ({ hydrateLoadedDataAfterProjectRecovery }));
vi.mock('../../App', () => ({ default: DummyApp }));
vi.mock('react-dom/client', () => ({ default: { createRoot }, createRoot }));
vi.mock('virtual:pwa-register', () => ({ registerSW: vi.fn() }));

describe('生产 main 启动接线', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="root"></div>';
    recoverPendingClearOperation.mockResolvedValue({
      ready: true, recovered: false, committed: null, error: null,
    });
  });

  it('实际入口委托单写者屏障，journal 预恢复与 store 后水合分层接线', async () => {
    recoverPendingProjectImport.mockResolvedValue({ recovered: false, error: null, reloadRequired: false });
    hydrateLoadedDataAfterProjectRecovery.mockResolvedValue({
      ready: true, hydrated: false, reloadRequired: false, error: null,
    });
    await import('../../main');
    expect(bootstrapApplication).toHaveBeenCalledOnce();
    expect(createRoot, '入口绕过屏障直接挂载了 React').not.toHaveBeenCalled();

    const wiring = bootstrapApplication.mock.calls[0][0];
    expect(wiring.acquireWriterLease).toBe(acquireAppWriterLease);
    await expect(wiring.recoverProjectData()).resolves.toEqual({
      ready: true, hydrated: false, reloadRequired: false, error: null,
    });
    expect(recoverPendingProjectImport).toHaveBeenCalledOnce();
    expect(recoverPendingClearOperation).toHaveBeenCalledOnce();
    expect(recoverPendingProjectImport.mock.invocationCallOrder[0])
      .toBeLessThan(recoverPendingClearOperation.mock.invocationCallOrder[0]);
    await expect(wiring.loadApp()).resolves.toBe(DummyApp);
    await wiring.hydrateLoadedData();
    expect(hydrateLoadedDataAfterProjectRecovery).toHaveBeenCalledOnce();

    wiring.mount('APP');
    expect(createRoot).toHaveBeenCalledWith(document.getElementById('root'));
  });

  it('journal 恢复要求刷新或失败时映射为启动阻断状态', async () => {
    recoverPendingProjectImport.mockResolvedValueOnce({
      recovered: true, error: '已前向恢复', reloadRequired: true,
    });
    await import('../../main');
    const wiring = bootstrapApplication.mock.calls[0][0];
    await expect(wiring.recoverProjectData()).resolves.toMatchObject({
      ready: false, hydrated: true, reloadRequired: true,
    });

    recoverPendingProjectImport.mockResolvedValueOnce({
      recovered: false, error: 'journal 不一致', reloadRequired: false,
    });
    await expect(wiring.recoverProjectData()).resolves.toEqual({
      ready: false, hydrated: false, reloadRequired: false, error: 'journal 不一致',
    });
    expect(recoverPendingClearOperation).not.toHaveBeenCalled();
  });

  it('清库恢复状态未知时在 App/store 加载前阻断启动', async () => {
    recoverPendingProjectImport.mockResolvedValue({
      recovered: false, error: null, reloadRequired: false,
    });
    recoverPendingClearOperation.mockResolvedValue({
      ready: false,
      recovered: false,
      committed: null,
      error: '清库回执暂不可查询',
    });
    await import('../../main');
    const wiring = bootstrapApplication.mock.calls[0][0];

    await expect(wiring.recoverProjectData()).resolves.toEqual({
      ready: false,
      hydrated: false,
      reloadRequired: false,
      error: '清库回执暂不可查询',
    });
    expect(recoverPendingProjectImport.mock.invocationCallOrder[0])
      .toBeLessThan(recoverPendingClearOperation.mock.invocationCallOrder[0]);
    expect(hydrateLoadedDataAfterProjectRecovery).not.toHaveBeenCalled();
  });
});
