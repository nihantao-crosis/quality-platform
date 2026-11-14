/**
 * 桌面壳（Tauri）关窗保护与启动提示（fix2609j G16-desktop）。
 *
 * Web/PWA 端的离开保护是 dataStore 的 beforeunload 监听：先 flush 单格编辑的合并落盘，
 * 仍有未持久化数据时 preventDefault。Tauri 的 WebView 在点关闭按钮 / Cmd+W / Cmd+Q
 * 时不会触发 beforeunload 确认，窗口会被直接销毁。这里在桌面端监听窗口的
 * close-requested 事件，复用同一个 beforeunload 判定：未持久化时弹原生确认，
 * 用户取消则阻止关闭。macOS 的 Cmd+Q 由 Rust 侧把「退出」菜单项改为逐窗口 close()，
 * 因而同样走这里。
 *
 * 本模块不导入任何业务 store：启动屏障之前也可以安全加载；判定通过派发合成的
 * beforeunload 事件完成，dataStore 未加载时没有监听器，自然放行关闭。
 */

export const DESKTOP_CLOSE_CONFIRM_MESSAGE =
  '当前数据尚未持久化，关闭窗口将丢失最新修改。\n\n建议先取消，然后用「文件 → 保存项目文件…」（Ctrl+S）备份。\n\n仍要关闭吗？';

/** 对话框本身不可用时，第二次关闭请求在此时限内放行，避免把用户困在无法关闭的窗口里。 */
export const DIALOG_FAILURE_FORCE_CLOSE_WINDOW_MS = 10_000;

export function isTauriRuntime(target: unknown = typeof window === 'undefined' ? undefined : window): boolean {
  return typeof target === 'object' && target !== null && '__TAURI_INTERNALS__' in target;
}

/**
 * 与 Web 端离开保护完全相同的判定：派发一个可取消的 beforeunload，
 * dataStore 的监听器会先 flushPendingCellPersistence()，再按未持久化标记 preventDefault。
 */
export function hasUnsavedWorkForClose(target: Window = window): boolean {
  const probe = new Event('beforeunload', { cancelable: true });
  target.dispatchEvent(probe);
  return probe.defaultPrevented;
}

export interface CloseRequestLike {
  preventDefault(): void;
}

export interface CloseGuardDeps {
  hasUnsavedWork(): boolean;
  confirmClose(message: string): Promise<boolean>;
  now?(): number;
}

export type CloseDecision = 'close' | 'kept';

export interface DesktopCloseGuard {
  handle(event: CloseRequestLike): Promise<CloseDecision>;
}

/** 关窗决策（纯逻辑，可测）：未持久化 → 确认；取消或对话框失败 → preventDefault。 */
export function createDesktopCloseGuard(deps: CloseGuardDeps): DesktopCloseGuard {
  const now = deps.now ?? (() => Date.now());
  let dialogFailedAt: number | null = null;
  return {
    async handle(event) {
      let unsaved: boolean;
      try {
        unsaved = deps.hasUnsavedWork();
      } catch {
        // 判定本身出错时按「可能有未保存数据」处理，交给用户确认。
        unsaved = true;
      }
      if (!unsaved) return 'close';
      let confirmed: boolean;
      try {
        confirmed = await deps.confirmClose(DESKTOP_CLOSE_CONFIRM_MESSAGE);
        dialogFailedAt = null;
      } catch (error) {
        const failedBefore = dialogFailedAt;
        dialogFailedAt = now();
        if (failedBefore !== null && dialogFailedAt - failedBefore <= DIALOG_FAILURE_FORCE_CLOSE_WINDOW_MS) {
          console.warn('关窗确认对话框连续不可用，按用户再次关闭的意图放行', error);
          return 'close';
        }
        console.warn('关窗确认对话框不可用；已阻止本次关闭，短时间内再次关闭将放行', error);
        confirmed = false;
      }
      if (confirmed) return 'close';
      event.preventDefault();
      return 'kept';
    },
  };
}

/**
 * 桌面端安装关窗拦截；Web/PWA 返回 null（那里由浏览器 beforeunload 负责）。
 * 注：@tauri-apps/api 的 onCloseRequested 在未 preventDefault 时会调用 window.destroy()，
 * capabilities/default.json 已授予 core:window:allow-destroy。
 */
export async function installDesktopCloseGuard(): Promise<(() => void) | null> {
  if (!isTauriRuntime()) return null;
  const [{ getCurrentWindow }, { ask }] = await Promise.all([
    import('@tauri-apps/api/window'),
    import('@tauri-apps/plugin-dialog'),
  ]);
  const guard = createDesktopCloseGuard({
    hasUnsavedWork: () => hasUnsavedWorkForClose(window),
    confirmClose: (message) => ask(message, {
      title: '数据尚未保存',
      kind: 'warning',
      okLabel: '仍要关闭',
      cancelLabel: '取消',
    }),
  });
  return getCurrentWindow().onCloseRequested(async (event) => {
    await guard.handle(event);
  });
}

/**
 * 取走 Rust 启动阶段记录的一次性提示（如损坏库已隔离保全的备份路径、另一实例占用库），
 * 以原生对话框告知用户。返回显示的文本（无提示时为 null）。
 */
export async function showDesktopStartupNotice(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const notice = await invoke<string | null>('desktop_take_startup_notice');
  if (!notice) return null;
  const { message } = await import('@tauri-apps/plugin-dialog');
  await message(notice, { title: '本机数据集库提示', kind: 'warning' });
  return notice;
}
