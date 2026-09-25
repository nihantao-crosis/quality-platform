/**
 * fix2609j · G16-desktop 回归（DESKTOP-03 / DESKTOP-02 前端侧）。
 *
 * DESKTOP-03：桌面壳关窗 / Cmd+Q 不触发 beforeunload，未持久化状态下窗口被直接销毁。
 * 复现口径（发现记录 reproMethod）：注入 __TAURI_INTERNALS__，本机库 put 抛错 + localStorage
 * 对活动槽抛 QuotaExceededError，用真实 importMatrix 把 activeUnpersisted 推成 true；
 * 修复前前端对 Tauri 一次 IPC 都没发、也没有任何 close-requested 监听。
 * 修复后：安装 onCloseRequested 监听，复用 beforeunload 同一判定，未确认则 preventDefault。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const tauriMocks = vi.hoisted(() => ({
  closeHandlers: [] as Array<(event: { preventDefault(): void }) => Promise<void> | void>,
  ask: vi.fn<(message: string, options?: unknown) => Promise<boolean>>(),
  message: vi.fn<(message: string, options?: unknown) => Promise<string>>(),
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: (event: { preventDefault(): void }) => Promise<void> | void) => {
      tauriMocks.closeHandlers.push(handler);
      return () => {
        const index = tauriMocks.closeHandlers.indexOf(handler);
        if (index >= 0) tauriMocks.closeHandlers.splice(index, 1);
      };
    },
  }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: tauriMocks.ask,
  message: tauriMocks.message,
  save: vi.fn(),
  open: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }));

import { platform, type DatasetDb } from '../../platform/adapter';
import {
  cancelPendingDatasetWork,
  markActiveDataReplaced,
  settlePendingDatasetWrites,
  useData,
} from '../../store/dataStore';
import {
  createDesktopCloseGuard,
  DESKTOP_CLOSE_CONFIRM_MESSAGE,
  DIALOG_FAILURE_FORCE_CLOSE_WINDOW_MS,
  hasUnsavedWorkForClose,
  installDesktopCloseGuard,
  isTauriRuntime,
  showDesktopStartupNotice,
} from '../../platform/desktopCloseGuard';

const nativeSetItem = Storage.prototype.setItem;

function failingDb(): DatasetDb {
  return {
    async put() { throw new Error('本机库已达到 1000 条上限'); },
    async get() { return null; },
    async list() { return []; },
    async remove() { return false; },
    async clear(opId) { return { opId, committed: true, removed: 0 }; },
    async clearStatus() { return null; },
    async stats() { return { count: 0, total_bytes: 0, path: ':memory:' }; },
  };
}

/** 真实生产路径把活动表推入「未持久化」：本机库写失败 + localStorage 活动槽配额满。 */
function makeActiveUnpersisted(): void {
  platform.datasetDb = failingDb();
  Storage.prototype.setItem = function quotaOnActive(key: string, value: string) {
    if (key === 'qp-dataset-v1') throw new DOMException('quota', 'QuotaExceededError');
    return nativeSetItem.call(this, key, value);
  };
  useData.getState().importMatrix('桌面未保存.csv', ['直径'], [[25.1], [25.2]]);
  expect(useData.getState().activeUnpersisted).toBe(true);
}

function setTauri(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

beforeEach(() => {
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  markActiveDataReplaced();
  tauriMocks.closeHandlers.length = 0;
  tauriMocks.ask.mockReset();
  tauriMocks.message.mockReset();
  tauriMocks.invoke.mockReset();
});

afterEach(async () => {
  Storage.prototype.setItem = nativeSetItem;
  setTauri(false);
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  markActiveDataReplaced();
  platform.datasetDb = null;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('DESKTOP-03 关窗判定复用 Web 端 beforeunload', () => {
  it('未持久化时判定为有未保存数据；持久化状态下放行', () => {
    expect(hasUnsavedWorkForClose()).toBe(false);
    makeActiveUnpersisted();
    expect(hasUnsavedWorkForClose()).toBe(true);
  });

  it('判定会先 flush 单格编辑的合并落盘（与 beforeunload 相同副作用）', () => {
    useData.getState().importMatrix('单格.csv', ['x'], [[1], [2]]);
    useData.getState().updateCell(0, 0, 77);
    // 合并窗口内尚未写回 localStorage。
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).rows[0][0]).toBe(1);
    expect(hasUnsavedWorkForClose()).toBe(false);
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).rows[0][0]).toBe(77);
  });
});

describe('DESKTOP-03 关窗决策', () => {
  it('未持久化 + 用户取消 → preventDefault，窗口保留', async () => {
    makeActiveUnpersisted();
    const confirmClose = vi.fn().mockResolvedValue(false);
    const guard = createDesktopCloseGuard({ hasUnsavedWork: () => hasUnsavedWorkForClose(), confirmClose });
    const preventDefault = vi.fn();
    await expect(guard.handle({ preventDefault })).resolves.toBe('kept');
    expect(confirmClose).toHaveBeenCalledWith(DESKTOP_CLOSE_CONFIRM_MESSAGE);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('未持久化 + 用户确认 → 放行关闭', async () => {
    makeActiveUnpersisted();
    const guard = createDesktopCloseGuard({
      hasUnsavedWork: () => hasUnsavedWorkForClose(),
      confirmClose: vi.fn().mockResolvedValue(true),
    });
    const preventDefault = vi.fn();
    await expect(guard.handle({ preventDefault })).resolves.toBe('close');
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('无未保存数据时不弹确认直接关闭', async () => {
    const confirmClose = vi.fn();
    const guard = createDesktopCloseGuard({ hasUnsavedWork: () => hasUnsavedWorkForClose(), confirmClose });
    const preventDefault = vi.fn();
    await expect(guard.handle({ preventDefault })).resolves.toBe('close');
    expect(confirmClose).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('判定抛错按「可能有未保存数据」处理，交给用户确认', async () => {
    const confirmClose = vi.fn().mockResolvedValue(false);
    const guard = createDesktopCloseGuard({ hasUnsavedWork: () => { throw new Error('boom'); }, confirmClose });
    const preventDefault = vi.fn();
    await expect(guard.handle({ preventDefault })).resolves.toBe('kept');
    expect(confirmClose).toHaveBeenCalledOnce();
  });

  it('确认对话框不可用：首次阻止，时限内再次关闭放行（不把用户困在窗口里）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let clock = 1_000;
    const guard = createDesktopCloseGuard({
      hasUnsavedWork: () => true,
      confirmClose: vi.fn().mockRejectedValue(new Error('dialog permission denied')),
      now: () => clock,
    });
    const first = vi.fn();
    await expect(guard.handle({ preventDefault: first })).resolves.toBe('kept');
    expect(first).toHaveBeenCalledOnce();
    clock += 2_000;
    const second = vi.fn();
    await expect(guard.handle({ preventDefault: second })).resolves.toBe('close');
    expect(second).not.toHaveBeenCalled();
    // 超过时限的失败重新计时。
    clock += DIALOG_FAILURE_FORCE_CLOSE_WINDOW_MS + 1;
    const third = vi.fn();
    await expect(guard.handle({ preventDefault: third })).resolves.toBe('kept');
  });
});

describe('DESKTOP-03 桌面端接线', () => {
  it('Web/PWA 下不安装（由浏览器 beforeunload 负责）', async () => {
    expect(isTauriRuntime()).toBe(false);
    await expect(installDesktopCloseGuard()).resolves.toBeNull();
    expect(tauriMocks.closeHandlers).toHaveLength(0);
  });

  it('桌面端注册 close-requested 监听；未持久化时经原生确认，取消则阻止关闭', async () => {
    setTauri(true);
    const unlisten = await installDesktopCloseGuard();
    expect(unlisten).toBeTypeOf('function');
    expect(tauriMocks.closeHandlers).toHaveLength(1);
    const handler = tauriMocks.closeHandlers[0];

    const cleanEvent = { preventDefault: vi.fn() };
    await handler(cleanEvent);
    expect(tauriMocks.ask).not.toHaveBeenCalled();
    expect(cleanEvent.preventDefault).not.toHaveBeenCalled();

    makeActiveUnpersisted();
    tauriMocks.ask.mockResolvedValueOnce(false);
    const event = { preventDefault: vi.fn() };
    await handler(event);
    expect(tauriMocks.ask).toHaveBeenCalledWith(
      DESKTOP_CLOSE_CONFIRM_MESSAGE,
      expect.objectContaining({ kind: 'warning', okLabel: '仍要关闭', cancelLabel: '取消' }),
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    unlisten!();
    expect(tauriMocks.closeHandlers).toHaveLength(0);
  });

  it('main.tsx 在启动屏障之前安装关窗保护并取启动提示', () => {
    const main = readFileSync('src/main.tsx', 'utf8');
    expect(main).toContain('installDesktopCloseGuard()');
    expect(main).toContain('showDesktopStartupNotice()');
    expect(main.indexOf('installDesktopCloseGuard()')).toBeLessThan(main.indexOf('void bootstrapApplication('));
  });

  it('桌面能力授予 window.destroy（onCloseRequested 放行时调用），Rust 把 Cmd+Q 改为逐窗口 close()', () => {
    const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8')) as { permissions: string[] };
    expect(capability.permissions).toContain('core:window:allow-destroy');
    const lib = readFileSync('src-tauri/src/lib.rs', 'utf8');
    expect(lib).toContain('GUARDED_QUIT_MENU_ID');
    expect(lib).toMatch(/window\.close\(\)/);
  });
});

describe('DESKTOP-02 启动提示（损坏库备份路径 / 另一实例占用）', () => {
  it('桌面端取走 Rust 记录的提示并以原生对话框显示', async () => {
    setTauri(true);
    const notice = '本机数据集库文件已损坏（file is not a database），无法读取。原文件已原样保全为：/Users/q/Library/Application Support/com.quality.platform/datasets.db.corrupt-20260926-103045';
    tauriMocks.invoke.mockResolvedValueOnce(notice);
    tauriMocks.message.mockResolvedValueOnce('Ok');
    await expect(showDesktopStartupNotice()).resolves.toBe(notice);
    expect(tauriMocks.invoke).toHaveBeenCalledWith('desktop_take_startup_notice');
    expect(tauriMocks.message).toHaveBeenCalledWith(notice, expect.objectContaining({ kind: 'warning' }));
  });

  it('无提示时不弹框；Web 端不发 IPC', async () => {
    await expect(showDesktopStartupNotice()).resolves.toBeNull();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    setTauri(true);
    tauriMocks.invoke.mockResolvedValueOnce(null);
    await expect(showDesktopStartupNotice()).resolves.toBeNull();
    expect(tauriMocks.message).not.toHaveBeenCalled();
  });
});
