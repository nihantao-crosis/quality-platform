import React from 'react';

// 蜂群 P2-08:桌面壳(Tauri)保留 1180 最小宽度;Web/PWA 走 index.css 的响应式断点
if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  document.documentElement.classList.add('is-desktop');
}
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { bootstrapApplication } from './bootstrap';
import { acquireAppWriterLease } from './platform/singleWriter';
// 字体本地打包（桌面端离线可用，交接文档 §10）
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './index.css';

function PwaUpdatePrompt() {
  const [needRefresh, setNeedRefresh] = React.useState(false);
  const updateRef = React.useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);

  React.useEffect(() => {
    updateRef.current = registerSW({
      immediate: true,
      onNeedRefresh: () => setNeedRefresh(true),
      onRegisterError: (error) => console.warn('PWA 更新检查失败', error),
    });
  }, []);

  if (!needRefresh) return null;
  return (
    <div role="status" aria-live="polite" style={{
      position: 'fixed', right: 18, bottom: 18, zIndex: 10000, maxWidth: 390,
      padding: '12px 14px', borderRadius: 8, background: '#17324d', color: '#fff',
      boxShadow: '0 10px 32px rgba(0,0,0,.28)', fontSize: 13, lineHeight: 1.55,
    }}>
      <div style={{ fontWeight: 700 }}>新版本已准备好</div>
      <div style={{ opacity: 0.9, marginTop: 2 }}>请先确认当前数据已保存；刷新后将统一切换到新版资源。</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
        <button type="button" onClick={() => setNeedRefresh(false)} style={{
          border: '1px solid rgba(255,255,255,.45)', background: 'transparent', color: '#fff',
          borderRadius: 5, padding: '5px 10px', cursor: 'pointer', fontFamily: 'inherit',
        }}>稍后</button>
        <button type="button" onClick={() => void updateRef.current?.(true)} style={{
          border: 0, background: '#fff', color: '#17324d', borderRadius: 5,
          padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700,
        }}>刷新应用</button>
      </div>
    </div>
  );
}

const rootElement = document.getElementById('root')!;

function mount(node: React.ReactNode) {
  ReactDOM.createRoot(rootElement).render(node);
}

void bootstrapApplication({
  acquireWriterLease: acquireAppWriterLease,
  // 先用不会加载业务 store 的 project 模块收口崩溃 journal。
  // 此阶段不得导入 App/dataStore/appStore。
  recoverProjectData: async () => {
    const recovery = await (await import('./platform/project')).recoverPendingProjectImport();
    if (recovery.reloadRequired) {
      return { ready: false, hydrated: recovery.recovered, reloadRequired: true, error: recovery.error };
    }
    if (recovery.error) {
      return { ready: false, hydrated: false, reloadRequired: false, error: recovery.error };
    }
    // 项目 journal 先收口；随后在任何业务 store 模块加载前，凭 SQLite
    // 持久回执裁决可能因崩溃中断的跨存储清库。状态未知必须阻断水合。
    const clearRecovery = await (await import('./platform/clearRecovery')).recoverPendingClearOperation();
    return {
      ready: clearRecovery.ready,
      hydrated: clearRecovery.recovered,
      reloadRequired: false,
      error: clearRecovery.error,
    };
  },
  // 只有取得唯一写租约后才加载 App/store 模块；这是跨窗口数据保护边界。
  loadApp: async () => (await import('./App')).default,
  // 此时 store 可安全水合；挂载前再收口仅存 SQLite 的活动表。
  hydrateLoadedData: async () => (await import('./store/dataStore')).hydrateLoadedDataAfterProjectRecovery(),
  renderApplication: (App) => (
    <React.StrictMode>
      <App />
      <PwaUpdatePrompt />
    </React.StrictMode>
  ),
  mount,
  reload: () => window.location.reload(),
});
