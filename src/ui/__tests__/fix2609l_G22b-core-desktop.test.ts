/**
 * fix2609l · G22b-core (10):桌面端导出接住 save_text_file / save_binary_file 的 Option<String> 警告。
 * Rust 端返回非 null 表示「文件已原子写入，但父目录同步未确认」;修复前前端忽略返回值，
 * 调用方提示「已保存」且会话日志无记录。修复后返回值(调用方原样拼进「已保存: …」提示)附警告后缀,
 * 并写一条会话日志。注入 __TAURI_INTERNALS__ 后重新加载 adapter,走真实 desktopAdapter。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
  save: vi.fn<(options?: unknown) => Promise<string | null>>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: tauri.save, open: vi.fn(), ask: vi.fn(), message: vi.fn() }));

async function loadDesktop() {
  vi.resetModules();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const adapter = await import('../../platform/adapter');
  const log = await import('../../store/sessionLog');
  expect(adapter.platform.isDesktop).toBe(true);
  return { platform: adapter.platform, useSessionLog: log.useSessionLog };
}

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.save.mockReset();
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('(10) 桌面导出目录同步警告', () => {
  it('文本导出:save_text_file 返回警告 → 返回值附「未能确认目录同步」并写会话日志', async () => {
    const { platform, useSessionLog } = await loadDesktop();
    tauri.save.mockResolvedValue('/Users/q/报告.html');
    tauri.invoke.mockResolvedValue('fsync parent directory failed: Operation not supported');
    const dest = await platform.exportFile({ defaultName: '报告', ext: 'html', filterLabel: 'HTML', text: '<p>x</p>' });
    expect(tauri.invoke).toHaveBeenCalledWith('save_text_file', expect.objectContaining({ path: '/Users/q/报告.html' }));
    expect(dest).toMatch(/^\/Users\/q\/报告\.html（文件已保存，但未能确认目录同步：fsync parent directory failed/);
    expect(useSessionLog.getState().entries.join('\n')).toMatch(/文件已保存，但未能确认目录同步 · \/Users\/q\/报告\.html/);
  });

  it('二进制导出同样接住;无警告(null)时返回纯路径、不写警告日志', async () => {
    const { platform, useSessionLog } = await loadDesktop();
    tauri.save.mockResolvedValue('/Users/q/报告.xlsx');
    tauri.invoke.mockResolvedValueOnce('sync_all on directory returned EIO');
    const warned = await platform.exportFile({ defaultName: '报告', ext: 'xlsx', filterLabel: 'Excel', bytes: new Uint8Array([1, 2, 3]) });
    expect(tauri.invoke).toHaveBeenCalledWith('save_binary_file', expect.objectContaining({ path: '/Users/q/报告.xlsx' }));
    expect(warned).toContain('未能确认目录同步：sync_all on directory returned EIO');

    tauri.invoke.mockResolvedValueOnce(null);
    const before = useSessionLog.getState().entries.length;
    const clean = await platform.exportFile({ defaultName: '报告', ext: 'xlsx', filterLabel: 'Excel', bytes: new Uint8Array([1]) });
    expect(clean).toBe('/Users/q/报告.xlsx');
    expect(useSessionLog.getState().entries.slice(before).join('')).not.toMatch(/目录同步/);
  });
});
