import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json';

/** 开发端口若曾运行过生产 PWA，浏览器会继续被旧 SW 控制；提供自销毁脚本清缓存并注销。 */
function devServiceWorkerCleanup(): Plugin {
  return {
    name: 'dev-service-worker-cleanup',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/sw.js') return next();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
  await self.registration.unregister();
  await self.clients.claim();
  for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
})()));
`);
      });
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    devServiceWorkerCleanup(),
    react(),
    // Web 端离线支持（工厂内网/断网可用）;Tauri 桌面端不受影响
    VitePWA({
      // 新 worker 等用户确认后才激活；避免旧页面动态加载导出 chunk 时被立即清掉旧 hash 缓存。
      registerType: 'prompt',
      injectRegister: null,
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        name: '质量分析平台',
        short_name: '质量分析',
        description: '类 Minitab 的工厂质量统计分析工具',
        lang: 'zh-CN',
        theme_color: '#1f6fb2',
        background_color: '#eef0f3',
        display: 'standalone',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  base: './', // 相对路径：Tauri 与 GitHub Pages 子路径均可用
  server: { port: 5188, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        // 导出重库各自成 chunk（配合 buildExportJob 的动态加载,导出时才拉取）
        manualChunks(id) {
          if (id.includes('node_modules/xlsx')) return 'vendor-xlsx';
          if (id.includes('node_modules/docx')) return 'vendor-docx';
          if (id.includes('node_modules/pptxgenjs')) return 'vendor-pptx';
          if (id.includes('react-dom/server')) return 'vendor-ssr';
        },
      },
    },
  },
});
