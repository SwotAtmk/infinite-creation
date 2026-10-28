import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Studio 使用独立后端实例（默认 4610，独立 .next-studio 构建目录），与经典界面 4600 互不干扰。
const BACKEND = process.env.STUDIO_BACKEND || 'http://127.0.0.1:4610';
// 默认绑定 0.0.0.0：局域网/隧道可以直接用本机内网 IP 访问 Studio。
// 只在本机用可以设 STUDIO_HOST=127.0.0.1。
const STUDIO_HOST = process.env.STUDIO_HOST || '0.0.0.0';

// studio 是独立前端：只做 UI，后端 API / WebSocket / 静态资源全部代理到主服务，
// 因此两套界面读写的是同一份数据和同一个任务队列，不会出现双后端抢 SQLite 的问题。
const proxy = {
  '/api': { target: BACKEND, changeOrigin: false },
  '/files': { target: BACKEND, changeOrigin: false },
  '/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../lib/shared/index.js'),
    },
  },
  server: {
    port: Number(process.env.STUDIO_PORT) || 4710,
    host: STUDIO_HOST,
    strictPort: true,
    // 通过 cpolar / ngrok / 反向代理访问时 Host 不是 localhost；
    // Vite 6 默认会返回 403 "Blocked request"，这里允许隧道域名。
    allowedHosts: true,
    fs: { allow: [path.resolve(__dirname), path.resolve(__dirname, '..')] },
    proxy,
  },
  preview: {
    port: Number(process.env.STUDIO_PORT) || 4710,
    host: STUDIO_HOST,
    strictPort: true,
    allowedHosts: true,
    proxy,
  },
});
