import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json';

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    // Web 端离线支持（工厂内网/断网可用）;Tauri 桌面端不受影响
    VitePWA({
      registerType: 'autoUpdate',
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
  server: { port: 5188 },
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
