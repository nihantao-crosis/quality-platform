import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <PwaUpdatePrompt />
  </React.StrictMode>,
);
