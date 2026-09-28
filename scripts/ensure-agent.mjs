#!/usr/bin/env node
// 幂等构建 Agent 内核：确保 vendor/openclaude/dist/sdk.mjs 存在。
// dist/ 是构建产物、不入库，所以首次运行会自动 bun install + bun run build；
// 已构建过则秒过（直接跳过），因此可以安全地挂在 dev/start 前面。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OC = path.join(ROOT, 'vendor', 'openclaude');
const SDK = path.join(OC, 'dist', 'sdk.mjs');

if (fs.existsSync(SDK)) {
  console.log('[agent] vendor/openclaude/dist/sdk.mjs 已存在，跳过构建。');
  process.exit(0);
}

console.log('[agent] 未找到 dist/sdk.mjs，开始构建 Agent 内核（首次较慢）...');

function run(cmd, args) {
  console.log('[agent] $ ' + cmd + ' ' + args.join(' '));
  const r = spawnSync(cmd, args, { cwd: OC, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error('[agent] 构建失败：' + cmd + ' 退出码 ' + r.status);
    process.exit(r.status ?? 1);
  }
}

// 确认 bun 可用
const bunCheck = spawnSync('bun', ['--version'], { stdio: 'ignore' });
if (bunCheck.error || bunCheck.status !== 0) {
  console.error('[agent] 未检测到 bun。请先安装 Bun：https://bun.sh ，然后重跑。');
  process.exit(1);
}

run('bun', ['install', '--ignore-scripts']); // sharp 为可选原生依赖，跳过其安装脚本即可
run('bun', ['run', 'build']); // 产出 dist/sdk.mjs + dist/cli.mjs

console.log('[agent] 完成：' + SDK);
