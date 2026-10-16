import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // 服务端专用依赖不做 webpack 打包，直接走 Node 原生加载（node:sqlite 等 node: 前缀模块本就自动 external）
  serverExternalPackages: ['adm-zip', 'sharp'],
  // sharp 是 openclaude 里「可选」的图片处理依赖（本项目已禁用对应工具，运行时实际用不到），
  // 且它只以一份不完整的嵌套安装存在于 vendor/openclaude/node_modules（缺少 @img/* 原生二进制，
  // 也不在根 node_modules 里，serverExternalPackages 按包名 external 时匹配不到）。webpack 打包时
  // 会静态解析 sharp 的 libvips.js / utility.js 里对 @img/sharp-libvips-dev/*、@img/sharp-wasm32/* 等
  // 可选依赖的 require()，找不到就每次编译刷一轮 "Module not found"。这里把 sharp 及 @img/* 显式
  // external 成运行时 require：缺包时 sharp 自带的 try/catch 兜底，且不再参与打包。
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals]).filter(Boolean),
        ({ request }, callback) => {
          if (request === 'sharp' || (request && request.startsWith('@img/'))) {
            return callback(null, `commonjs ${request}`);
          }
          callback();
        },
      ];
    }
    return config;
  },
  // HeroUI 组件库需经 Next 转译以正确处理其 ESM/样式导入
  transpilePackages: ['@heroui/react', '@heroui/theme'],
  // 显式指定工作区根目录，避免 Next.js 因检测到多个 lockfile 而误判到用户主目录
  outputFileTracingRoot: __dirname,
  // 允许这些来源访问 /_next/* 资源，消除跨域提示
  // 注意：Next.js 禁止用单独的 * 或 ** 匹配整个域名（安全防护），必须列出具体主机名
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
};

export default nextConfig;
