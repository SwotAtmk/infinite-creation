import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // 多实例（如 Studio 后端与经典后端同时运行）时用独立的构建目录，避免两个 Next dev
  // 共用 .next 互相覆盖路由产物（表现为 /api/* 间歇性 404/500）。
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // 服务端专用依赖不做 webpack 打包，直接走 Node 原生加载（node:sqlite 等 node: 前缀模块本就自动 external）
  serverExternalPackages: ['adm-zip', 'sharp'],
  // sharp 是 openclaude 里「可选」的图片处理依赖（本项目已禁用对应工具，运行时实际用不到），
  // 且它只以一份不完整的嵌套安装存在于 vendor/openclaude/node_modules（缺少 @img/* 原生二进制，
  // 也不在根 node_modules 里，serverExternalPackages 按包名 external 时匹配不到）。webpack 打包时
  // 会静态解析 sharp 的 libvips.js / utility.js 里对 @img/sharp-libvips-dev/*、@img/sharp-wasm32/* 等
  // 可选依赖的 require()，找不到就每次编译刷一轮 "Module not found"。这里把 sharp 及 @img/* 显式
  // external 成运行时 require：缺包时 sharp 自带的 try/catch 兜底，且不再参与打包。
  webpack: (config, { isServer, dev }) => {
    // studio/ 是独立前端工程（Vite + 自有 node_modules / dist）：Next dev 的 watcher
    // 不需要扫描它，否则会反复遍历大量无关文件，拖慢路由编译。data/、logs/ 同理。
    if (dev) {
      config.watchOptions = {
        ...(config.watchOptions || {}),
        // 启动耗时大头在这里：Next dev 会把监听到的目录先完整扫一遍（Windows 上尤其慢）。
        // vendor/ 有 4.2 万个文件（openclaude SDK 的整套源码与依赖），是 data/ 的 5 倍以上，
        // 之前只忽略了 vendor/openclaude/node_modules，导致冷启动卡在 app.prepare() 里约 2 分钟。
        // 这些目录都不参与 Next 的按需编译，忽略后不影响 HMR 与路由产物。
        ignored: [
          '**/node_modules/**',
          '**/.next/**',
          '**/.next-*/**',
          '**/studio/**',
          '**/data/**',
          '**/logs/**',
          '**/vendor/**',
          '**/skills/**',
        ],
      };
    }
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
