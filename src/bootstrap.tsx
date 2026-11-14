import type { ComponentType, ReactNode } from 'react';
import type { AppWriterLeaseResult } from './platform/singleWriter';

export interface StartupState {
  ready: boolean;
  hydrated: boolean;
  reloadRequired: boolean;
  error: string | null;
}

export interface BootstrapDependencies {
  acquireWriterLease(): Promise<AppWriterLeaseResult>;
  /** 无业务 store 副作用的 journal/SQLite 预恢复。 */
  recoverProjectData(): Promise<StartupState>;
  loadApp(): Promise<ComponentType>;
  /** App/store 水合后、挂载前恢复仅存 SQLite 的活动表。 */
  hydrateLoadedData(): Promise<StartupState>;
  renderApplication(App: ComponentType): ReactNode;
  mount(node: ReactNode): void;
  reload(): void;
}

export function StartupNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <main role="alert" style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24,
      background: '#f4f7fa', color: '#17324d', fontFamily: 'IBM Plex Sans, sans-serif',
    }}>
      <section style={{
        width: 'min(560px, 100%)', padding: 24, borderRadius: 10, background: '#fff',
        border: '1px solid #d9e2eb', boxShadow: '0 12px 32px rgba(23,50,77,.1)',
      }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{title}</h1>
        <p style={{ margin: '12px 0 0', lineHeight: 1.65, fontSize: 14 }}>{detail}</p>
      </section>
    </main>
  );
}

/**
 * 生产启动屏障的可测试编排器。顺序是硬不变量：唯一写租约 →
 * 无 store 副作用的项目 journal 恢复 → loadApp/store 水合 → 活动 SQLite 表恢复 → 挂载。
 * App/store 模块在加载时就会读写持久层，因此不能与 journal 恢复并行。
 */
export async function bootstrapApplication(deps: BootstrapDependencies): Promise<void> {
  try {
    const lease = await deps.acquireWriterLease();
    if (!lease.acquired) {
      deps.mount(
        <StartupNotice
          title="项目已在另一个窗口中打开"
          detail={`${lease.detail ?? '当前项目已有活动窗口。'} 为防止工作表、AQL 批次和项目备份互相覆盖，本窗口保持只读阻断状态。请关闭其他窗口后刷新本页。`}
        />,
      );
      return;
    }

    const recovery = await deps.recoverProjectData();
    if (recovery.reloadRequired) {
      deps.reload();
      return;
    }
    if (!recovery.ready) {
      deps.mount(
        <StartupNotice
          title="项目数据尚未恢复完成"
          detail={`${recovery.error ?? '本机项目恢复暂时无法完成。'} 为保护原数据，编辑功能已暂停。请释放存储空间或检查本机数据文件后重新启动。`}
        />,
      );
      return;
    }

    // 只有 journal/SQLite 跨层事务已完整收口，才允许评估带模块级
    // localStorage 水合/订阅的 App 依赖图。
    const App = await deps.loadApp();
    const startup = await deps.hydrateLoadedData();
    if (startup.reloadRequired) {
      deps.reload();
      return;
    }
    if (!startup.ready) {
      deps.mount(
        <StartupNotice
          title="项目数据尚未恢复完成"
          detail={`${startup.error ?? '本机活动数据恢复暂时无法完成。'} 为保护原数据，编辑功能已暂停。请释放存储空间或检查本机数据文件后重新启动。`}
        />,
      );
      return;
    }
    deps.mount(deps.renderApplication(App));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.mount(
      <StartupNotice
        title="项目数据检查失败"
        detail={`${detail} 为保护原数据，编辑功能已暂停；请重新启动后重试。`}
      />,
    );
  }
}
