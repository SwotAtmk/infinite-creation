#!/usr/bin/env node
// 把仓库里的 ic-writer 技能安装到 harness（opencode 等）的技能目录。
// 用法：
//   node scripts/install-writer-skill.mjs                  # 默认装到 ~/.agents/skills/ic-writer
//   node scripts/install-writer-skill.mjs --target <dir>   # 自定义技能根目录
//   node scripts/install-writer-skill.mjs --print          # 只打印目标路径，不写文件
//
// 为什么要有这一步：仓库 skills/ 是「内置 Agent 的技能库」，而外部 harness 只读自己的
// 技能目录（opencode 读 ~/.agents/skills/）。仓库内保留一份可版本化的源，安装脚本负责同步。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'skills', 'ic-writer');
const NAME = 'ic-writer';

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const targetRoot = targetIdx !== -1
  ? path.resolve(args[targetIdx + 1] || '')
  : path.join(os.homedir(), '.agents', 'skills');
const printOnly = args.includes('--print');

function main() {
  if (!fs.existsSync(path.join(SRC, 'SKILL.md'))) {
    throw new Error('未找到技能源：' + path.join(SRC, 'SKILL.md'));
  }
  const dest = path.join(targetRoot, NAME);
  if (printOnly) {
    console.log(dest);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  // 递归复制整个技能目录（含未来的 references/），保持目录结构
  const walk = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, e.name);
      const d = path.join(to, e.name);
      if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); walk(s, d); }
      else { fs.writeFileSync(d, fs.readFileSync(s)); n++; }
    }
  };
  walk(SRC, dest);
  console.log('已安装 ic-writer → ' + dest + '（' + n + ' 个文件）');
  console.log('提示：新装的技能需要重启 harness 会话（opencode）后才会被发现。');
}

try { main(); } catch (e) { console.error('[error] ' + e.message); process.exit(1); }
