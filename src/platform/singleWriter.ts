/**
 * 项目级单写者租约。
 *
 * 质量平台的活动工作表、AQL 责任账本和项目 journal 都是“整份状态”提交；
 * 两个同源标签/PWA 窗口同时编辑会形成无法安全自动合并的状态机冲突。生产入口
 * 因此必须在加载任何 store（store 模块加载即会水合/持久化）之前取得唯一写租约。
 *
 * 只使用浏览器原生 Web Locks：窗口崩溃时锁由浏览器自动释放。不再回落
 * 到带 TTL 的 IndexedDB 租约：后台页被冻结超过 TTL 后，新窗口可取代它，
 * 而旧页恢复到完成异步续租前仍可写入，无法为 localStorage 提供真正的 fencing。
 * 缺少 Web Locks 时因此 fail closed，不以一个伪安全 fallback 换取表面可用性。
 */

export interface AppWriterLeaseResult {
  acquired: boolean;
  backend: 'web-locks' | 'unavailable';
  detail?: string;
}

const LOCK_NAME = 'quality-platform-project-writer-v1';

let acquisition: Promise<AppWriterLeaseResult> | null = null;
let releaseHeldLease: (() => void) | null = null;

function installRelease(release: () => void): void {
  releaseHeldLease = release;
  if (typeof window !== 'undefined') {
    // 进入 BFCache 的页面仍是可恢复的活上下文；若在 persisted pagehide
    // 释放锁，返回时 App/store 会继续运行却不再经启动屏障，重新变成旧 writer。
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      release();
      window.removeEventListener('pagehide', onPageHide);
    };
    window.addEventListener('pagehide', onPageHide);
  }
}

function acquireWebLock(): Promise<AppWriterLeaseResult> | null {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return null;
  return new Promise<AppWriterLeaseResult>((resolve) => {
    let settled = false;
    const finish = (result: AppWriterLeaseResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    void navigator.locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) {
        finish({ acquired: false, backend: 'web-locks', detail: '另一个质量平台窗口正在使用当前项目' });
        return;
      }
      let release!: () => void;
      const held = new Promise<void>((done) => { release = done; });
      installRelease(release);
      finish({ acquired: true, backend: 'web-locks' });
      await held;
    }).catch((error: unknown) => {
      finish({
        acquired: false,
        backend: 'unavailable',
        detail: `浏览器无法建立项目写锁：${error instanceof Error ? error.message : String(error)}`,
      });
    });
  });
}

export function acquireAppWriterLease(): Promise<AppWriterLeaseResult> {
  if (acquisition) return acquisition;
  acquisition = acquireWebLock() ?? Promise.resolve({
    acquired: false,
    backend: 'unavailable',
    detail: '当前浏览器不支持安全的 Web Locks 项目写锁；请使用当前版本的 Chrome、Edge、Safari 或桌面客户端',
  } satisfies AppWriterLeaseResult);
  return acquisition;
}

/** 仅供测试；生产不主动释放后继续复用同一页面上下文。 */
export function __resetAppWriterLeaseForTests(): void {
  releaseHeldLease?.();
  releaseHeldLease = null;
  acquisition = null;
}
