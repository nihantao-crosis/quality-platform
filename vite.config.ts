import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // 相对路径：Tauri 与 GitHub Pages 子路径均可用
  server: { port: 5188 },
});
