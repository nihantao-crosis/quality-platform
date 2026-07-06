import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json';

/**
 * 便携版构建 — 整个应用（JS/CSS/字体）内联为单个 HTML,
 * 拷贝到任意机器用浏览器打开（file://）即可使用,零安装零网络。
 * 无 PWA / 无代码分割（单文件必须内联全部动态导入）。
 */
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version + '-portable') },
  plugins: [react(), viteSingleFile()],
  base: './',
  publicDir: false, // 单文件分发,不带 PWA 图标等静态资源
  build: {
    outDir: 'dist-portable',
    assetsInlineLimit: 100 * 1024 * 1024,
    chunkSizeWarningLimit: 10000,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
