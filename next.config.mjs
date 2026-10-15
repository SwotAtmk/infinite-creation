import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // 服务端专用依赖不做 webpack 打包，直接走 Node 原生加载（node:sqlite 等 node: 前缀模块本就自动 external）
  serverExternalPackages: ['adm-zip', 'sharp'],
  // HeroUI 组件库需经 Next 转译以正确处理其 ESM/样式导入
  transpilePackages: ['@heroui/react', '@heroui/theme'],
  // 显式指定工作区根目录，避免 Next.js 因检测到多个 lockfile 而误判到用户主目录
  outputFileTracingRoot: __dirname,
  // 允许这些来源访问 /_next/* 资源，消除跨域提示
  // 注意：Next.js 禁止用单独的 * 或 ** 匹配整个域名（安全防护），必须列出具体主机名
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
};

export default nextConfig;
