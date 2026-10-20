// 外部 Agent 工作区与 MCP 配置生成。
// 每个任务一个独立目录，避免污染项目目录，也避免不同 CLI 的配置互相覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, ROOT } from '../../core/config.js';
import { MCP_SERVER_NAME } from './defs/shared.js';

const WORKSPACES_DIR = path.join(DATA_DIR, 'agent-workspaces');
const MCP_SERVER_PATH = path.join(ROOT, 'lib', 'agent', 'external', 'mcp-server.mjs');

export function mcpServerSpec() {
  return { command: process.execPath, args: [MCP_SERVER_PATH] };
}

export function mcpConfigSnippet(spec = mcpServerSpec()) {
  return { mcpServers: { [MCP_SERVER_NAME]: { command: spec.command, args: spec.args } } };
}

export function createWorkspace(jobId) {
  const safe = String(jobId || 'job').replace(/[^A-Za-z0-9_-]/g, '_');
  const ws = path.join(WORKSPACES_DIR, safe);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

export function cleanupWorkspace(ws, keep) {
  if (!ws || keep) return;
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writeJson(file, obj) {
  writeText(file, JSON.stringify(obj, null, 2) + '\n');
}

function yamlScalar(value) {
  // YAML 双引号字符串与 JSON 字符串语法兼容，路径里的反斜杠会被正确转义。
  return JSON.stringify(String(value));
}

function prepareHermes(ws, spec) {
  const hermesHome = path.join(ws, 'hermes-home');
  const srcRoot = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
  const src = path.join(srcRoot, 'config.yaml');
  let text = '';
  try { text = fs.readFileSync(src, 'utf8'); } catch {}

  // 已有同名 server 就不重复插入（避免 YAML 重复键）。
  if (!/^\s{2}infinite_creation:\s*$/m.test(text)) {
    const block = [
      '  infinite_creation:',
      '    command: ' + yamlScalar(spec.command),
      '    args:',
      ...spec.args.map((a) => '      - ' + yamlScalar(a)),
    ].join('\n');
    if (/^mcp_servers:\s*$/m.test(text)) {
      text = text.replace(/^mcp_servers:\s*$/m, (m) => m + '\n' + block);
    } else {
      const head = text.trim() ? text.replace(/\s*$/, '\n') : '';
      text = head + 'mcp_servers:\n' + block + '\n';
    }
  }
  writeText(path.join(hermesHome, 'config.yaml'), text);
  // 认证信息可能不在 config.yaml：把常见的凭据文件一起带到临时 HERMES_HOME，
  // 避免切换 HOME 后 Hermes 变成未登录状态（不改动用户原目录）。
  for (const name of ['.env', 'auth.json', 'credentials.json']) {
    try { fs.copyFileSync(path.join(srcRoot, name), path.join(hermesHome, name)); } catch {}
  }
  return { HERMES_HOME: hermesHome };
}

// 写各 CLI 的 MCP 配置；返回需要额外注入的环境变量。
export function writeMcpConfigs(def, ws, spec = mcpServerSpec()) {
  const server = { command: spec.command, args: spec.args };
  const mcpServers = { [MCP_SERVER_NAME]: server };

  // 通用配置：供自定义 CLI 的 {mcpConfig} 占位符、以及设置页复制。
  writeJson(path.join(ws, 'mcp.json'), { mcpServers });

  switch (def.id) {
    case 'claude':
      writeJson(path.join(ws, 'claude-mcp.json'), {
        mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', ...server } },
      });
      break;
    case 'gemini':
      writeJson(path.join(ws, '.gemini', 'settings.json'), { mcpServers });
      break;
    case 'qwen':
      writeJson(path.join(ws, '.qwen', 'settings.json'), {
        mcpServers: { [MCP_SERVER_NAME]: { ...server, trust: true } },
      });
      break;
    case 'cursor-agent':
      writeJson(path.join(ws, '.cursor', 'mcp.json'), { mcpServers });
      break;
    case 'qoder-cli':
      writeJson(path.join(ws, '.qoder', 'settings.json'), { mcpServers });
      break;
    case 'grok':
      writeText(path.join(ws, '.grok', 'config.toml'), [
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        'command = ' + JSON.stringify(String(spec.command)),
        'args = ' + JSON.stringify(spec.args.map(String)),
        '',
      ].join('\n'));
      break;
    case 'hermes':
      return prepareHermes(ws, spec);
    default:
      break;
  }
  return {};
}

export function mcpEnv({ projectId, jobId, chapter, renderDisabled, logFile, progressFile, abortFile }) {
  return {
    IC_MCP_PROJECT_ID: String(projectId || ''),
    IC_MCP_JOB_ID: String(jobId || ''),
    IC_MCP_CHAPTER: String(chapter || ''),
    IC_MCP_RENDER_DISABLED: renderDisabled ? '1' : '0',
    IC_MCP_LOG_FILE: String(logFile || ''),
    IC_MCP_PROGRESS_FILE: String(progressFile || ''),
    IC_MCP_ABORT_FILE: String(abortFile || ''),
  };
}

export { MCP_SERVER_PATH };
