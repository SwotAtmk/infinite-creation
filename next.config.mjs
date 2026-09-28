import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // 服务端专用依赖不做 webpack 打包，直接走 Node 原生加载（node:sqlite 等 node: 前缀模块本就自动 external）
  serverExternalPackages: ['adm-zip'],
  // 显式指定工作区根目录，避免 Next.js 因检测到多个 lockfile 而误判到用户主目录
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
