import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    // 移除 COOP/COEP：跨源隔离会强制拦截跨源 iframe，破坏内置浏览器内嵌网页。
    // SharedArrayBuffer（跨 Worker 共享内存）为预留能力，当前跨 Worker 通信走 postMessage。
  },
  preview: {},
  worker: {
    format: 'es',
  },
});