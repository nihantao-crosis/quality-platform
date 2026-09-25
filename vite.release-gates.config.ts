import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json';

/**
 * 发布专用真浏览器 harness：动态导入与依赖全部内联，确保它和便携版一样可在
 * file://、网络被 CDP 强制离线的 Chrome 中运行。
 */
export default defineConfig({
  root: '.github/browser-harness',
  define: { __APP_VERSION__: JSON.stringify(pkg.version + '-release-gate') },
  plugins: [react(), viteSingleFile()],
  base: './',
  publicDir: false,
  build: {
    outDir: '../../dist/release-gates',
    emptyOutDir: true,
    assetsInlineLimit: 100 * 1024 * 1024,
    chunkSizeWarningLimit: 10_000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
