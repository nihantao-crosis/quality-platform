/**
 * @vitest-environment jsdom
 * 蜂群修复：生产入口必须在加载任何 store 之前取得项目单写锁，
 * 并在持久化恢复完成前不挂载 App。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import { bootstrapApplication, type BootstrapDependencies } from '../../bootstrap';
import { __resetAppWriterLeaseForTests, acquireAppWriterLease } from '../../platform/singleWriter';

const DummyApp: ComponentType = () => null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function deps(overrides: Partial<BootstrapDependencies> = {}) {
  const mounted: ReactNode[] = [];
  const base: BootstrapDependencies = {
    acquireWriterLease: vi.fn(async () => ({ acquired: true, backend: 'web-locks' as const })),
    recoverProjectData: vi.fn(async () => ({ ready: true, hydrated: false, reloadRequired: false, error: null })),
    loadApp: vi.fn(async () => DummyApp),
    hydrateLoadedData: vi.fn(async () => ({ ready: true, hydrated: true, reloadRequired: false, error: null })),
    renderApplication: vi.fn(() => 'APP'),
    mount: vi.fn((node) => { mounted.push(node); }),
    reload: vi.fn(),
    ...overrides,
  };
  return { base, mounted };
}

describe('项目单写者与启动恢复屏障', () => {
  beforeEach(() => __resetAppWriterLeaseForTests());
  afterEach(() => {
    __resetAppWriterLeaseForTests();
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('写锁未决时不加载 App/store，也不挂载界面', async () => {
    const lease = deferred<{ acquired: boolean; backend: 'web-locks' }>();
    const { base } = deps({ acquireWriterLease: vi.fn(() => lease.promise) });
    const running = bootstrapApplication(base);
    await Promise.resolve();
    expect(base.loadApp).not.toHaveBeenCalled();
    expect(base.recoverProjectData).not.toHaveBeenCalled();
    expect(base.hydrateLoadedData).not.toHaveBeenCalled();
    expect(base.mount).not.toHaveBeenCalled();
    lease.resolve({ acquired: false, backend: 'web-locks' });
    await running;
  });

  it('第二窗口被拒绝时只显示阻断页，不导入 store', async () => {
    const { base, mounted } = deps({
      acquireWriterLease: vi.fn(async () => ({ acquired: false, backend: 'web-locks' as const, detail: '已被占用' })),
    });
    await bootstrapApplication(base);
    expect(base.loadApp).not.toHaveBeenCalled();
    expect(base.recoverProjectData).not.toHaveBeenCalled();
    expect(base.hydrateLoadedData).not.toHaveBeenCalled();
    expect(base.renderApplication).not.toHaveBeenCalled();
    expect(mounted).toHaveLength(1);
  });

  it('journal 恢复未完成时不得加载 App/store，ready 后才依次水合并挂载', async () => {
    const startup = deferred<{ ready: boolean; hydrated: boolean; reloadRequired: boolean; error: null }>();
    const order: string[] = [];
    const { base } = deps({
      recoverProjectData: vi.fn(() => startup.promise),
      loadApp: vi.fn(async () => { order.push('load-app'); return DummyApp; }),
      hydrateLoadedData: vi.fn(async () => {
        order.push('hydrate-loaded');
        return { ready: true, hydrated: true, reloadRequired: false, error: null };
      }),
    });
    const running = bootstrapApplication(base);
    await Promise.resolve();
    await Promise.resolve();
    expect(base.loadApp).not.toHaveBeenCalled();
    expect(base.hydrateLoadedData).not.toHaveBeenCalled();
    expect(base.mount).not.toHaveBeenCalled();
    startup.resolve({ ready: true, hydrated: true, reloadRequired: false, error: null });
    await running;
    expect(order).toEqual(['load-app', 'hydrate-loaded']);
    expect(base.renderApplication).toHaveBeenCalledWith(DummyApp);
    expect(base.mount).toHaveBeenCalledWith('APP');
  });

  it('journal ready=false/reloadRequired 分支永不加载 App/store', async () => {
    const notReady = deps({
      recoverProjectData: vi.fn(async () => ({ ready: false, hydrated: false, reloadRequired: false, error: '恢复失败' })),
    });
    await bootstrapApplication(notReady.base);
    expect(notReady.base.loadApp).not.toHaveBeenCalled();
    expect(notReady.base.hydrateLoadedData).not.toHaveBeenCalled();
    expect(notReady.base.renderApplication).not.toHaveBeenCalled();
    expect(notReady.base.mount).toHaveBeenCalledOnce();

    const reload = deps({
      recoverProjectData: vi.fn(async () => ({ ready: false, hydrated: true, reloadRequired: true, error: null })),
    });
    await bootstrapApplication(reload.base);
    expect(reload.base.reload).toHaveBeenCalledOnce();
    expect(reload.base.loadApp).not.toHaveBeenCalled();
    expect(reload.base.hydrateLoadedData).not.toHaveBeenCalled();
    expect(reload.base.mount).not.toHaveBeenCalled();
    expect(reload.base.renderApplication).not.toHaveBeenCalled();
  });

  it('业务 store 加载后的活动表恢复失败仍不挂载可编辑 App', async () => {
    const blocked = deps({
      hydrateLoadedData: vi.fn(async () => ({
        ready: false, hydrated: false, reloadRequired: false, error: 'SQLite 活动表冲突',
      })),
    });
    await bootstrapApplication(blocked.base);
    expect(blocked.base.loadApp).toHaveBeenCalledOnce();
    expect(blocked.base.renderApplication).not.toHaveBeenCalled();
    expect(blocked.base.mount).toHaveBeenCalledOnce();
  });

  it('Web Locks 真实合同：获锁后持有到页面释放，无可用锁时 fail closed', async () => {
    let released = false;
    const request = vi.fn((_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
      const done = callback({});
      void done.then(() => { released = true; });
      return done;
    });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    await expect(acquireAppWriterLease()).resolves.toMatchObject({ acquired: true, backend: 'web-locks' });
    expect(request).toHaveBeenCalledWith(
      'quality-platform-project-writer-v1',
      { mode: 'exclusive', ifAvailable: true },
      expect.any(Function),
    );
    // BFCache 隐藏后页面会原地恢复，不得释放锁变成旧 writer。
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    await Promise.resolve();
    expect(released).toBe(false);
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(true);
    __resetAppWriterLeaseForTests();

    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: vi.fn((_n: string, _o: unknown, callback: (lock: null) => Promise<void>) => callback(null)) },
    });
    await expect(acquireAppWriterLease()).resolves.toMatchObject({ acquired: false, backend: 'web-locks' });
  });

  it('不支持 Web Locks 时 fail closed，不回落到可失效的 TTL 租约', async () => {
    Reflect.deleteProperty(navigator, 'locks');
    await expect(acquireAppWriterLease()).resolves.toMatchObject({
      acquired: false,
      backend: 'unavailable',
    });
  });
});
