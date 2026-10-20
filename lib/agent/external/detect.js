// 外部 Agent 检测：PATH 查找 + 版本探测 + 5 分钟缓存。
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AGENT_DEFS } from './registry.js';
import { customAgentDef } from './defs/custom.js';

const exec = promisify(execFile);
const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which';

// GUI 启动的 Node 进程 PATH 往往不完整，这里补上常见安装目录；extraPath 来自设置页。
export function augmentedPath(extraPath = '') {
  const sep = path.delimiter;
  const home = os.homedir();
  const extra = [];
  if (extraPath) extra.push(...String(extraPath).split(sep).map((s) => s.trim()).filter(Boolean));
  if (process.platform === 'win32') {
    if (process.env.APPDATA) extra.push(path.join(process.env.APPDATA, 'npm'));
  } else {
    extra.push(
      path.join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
    );
  }
  const cur = process.env.PATH || '';
  return [...new Set([...extra, ...cur.split(sep)].filter(Boolean))].join(sep);
}

function envWithPath(extraPath) {
  return { ...process.env, PATH: augmentedPath(extraPath) };
}

async function which(bin, extraPath) {
  if (!bin) return null;
  try {
    // 8s：detectAll 会并发探测 8 个 Agent，Windows 上 which/where 争抢时单次可能较慢。
    const { stdout } = await exec(WHICH_CMD, [bin], { timeout: 8000, env: envWithPath(extraPath) });
    const first = String(stdout || '').trim().split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

export async function probeVersion(bin, args = [], extraPath = '') {
  try {
    const { stdout } = await exec(bin, args, { timeout: 5000, env: envWithPath(extraPath) });
    return String(stdout || '').trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

export async function resolveBin(def, extraPath = '') {
  return which(def?.bin, extraPath);
}

export async function detectOne(def, extraPath = '') {
  const resolved = await resolveBin(def, extraPath);
  if (!resolved) {
    return {
      id: def.id,
      name: def.name,
      bin: def.bin,
      available: false,
      ...(def.installUrl ? { installUrl: def.installUrl } : {}),
    };
  }
  const version = await probeVersion(resolved, def.versionArgs, extraPath);
  let hint = null;
  // 叫 codex 的 npm 包不止一个：旧版/社区版没有 exec/-c MCP 参数，选它会在启动时失败。
  // 旧版对 `exec --help` 也会打印通用帮助并退出 0，所以要检查输出里是否真的出现 `codex exec`。
  if (def.id === 'codex') {
    try {
      const { stdout, stderr } = await exec(resolved, ['exec', '--help'], { timeout: 5000, env: envWithPath(extraPath) });
      const text = String(stdout || '') + String(stderr || '');
      if (!/codex\s+exec/i.test(text)) {
        hint = '当前 codex 不支持 exec/-c MCP 参数（可能不是 OpenAI Codex CLI）；请安装官方 Codex CLI 后再选它。';
      }
    } catch {
      hint = '当前 codex 不支持 exec/-c MCP 参数（可能不是 OpenAI Codex CLI）；请安装官方 Codex CLI 后再选它。';
    }
  }
  return {
    id: def.id,
    name: def.name,
    bin: def.bin,
    available: true,
    path: resolved,
    version,
    ...(hint ? { hint } : {}),
    ...(def.installUrl ? { installUrl: def.installUrl } : {}),
  };
}

export async function detectCustom(custom, extraPath = '') {
  return detectOne(customAgentDef(custom), extraPath);
}

const DETECT_TTL_MS = 5 * 60 * 1000;
let detectCache = null;

export async function detectAll({ force = false, extraPath = '' } = {}) {
  const now = Date.now();
  if (!force && detectCache && detectCache.extraPath === extraPath && now - detectCache.ts < DETECT_TTL_MS) {
    return detectCache.result;
  }
  const result = await Promise.all(AGENT_DEFS.map((def) => detectOne(def, extraPath)));
  detectCache = { ts: now, extraPath, result };
  return result;
}
