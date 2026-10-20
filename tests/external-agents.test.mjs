import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAgentDef, customAgentDef, parseCustomArgs } from '../lib/agent/external/index.js';
import { TOOL_DEFINITIONS } from '../lib/agent/tools.js';
import { resolveHardwareConfig } from '../lib/core/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Agent 定义：Claude 启动参数包含 MCP 配置', () => {
  const def = findAgentDef('claude');
  const ws = path.join(os.tmpdir(), 'ic-ws');
  const args = def.buildArgs({
    prompt: 'P',
    ws,
    nodeBin: '/usr/bin/node',
    mcpServer: { command: '/usr/bin/node', args: ['/x/mcp-server.mjs'] },
    mcpConfigPath: path.join(ws, 'mcp.json'),
  });
  assert.ok(args.includes('--mcp-config'));
  assert.ok(args.includes(path.join(ws, 'claude-mcp.json')));
});

test('自定义命令：分词与占位符替换', () => {
  assert.deepEqual(parseCustomArgs('--model x "a b" \'c d\''), ['--model', 'x', 'a b', 'c d']);

  const withPrompt = customAgentDef({ bin: 'my-agent', args: '--model x {prompt}', promptViaStdin: false });
  assert.deepEqual(
    withPrompt.buildArgs({ prompt: 'P', ws: '/tmp/w', mcpConfigPath: '/tmp/w/mcp.json' }),
    ['--model', 'x', 'P'],
  );

  const withMcp = customAgentDef({ bin: 'my-agent', args: '--mcp {mcpConfig}', promptViaStdin: true });
  assert.deepEqual(
    withMcp.buildArgs({ prompt: 'P', ws: '/tmp/w', mcpConfigPath: '/tmp/w/mcp.json' }),
    ['--mcp', '/tmp/w/mcp.json'],
  );

  const stdinOnly = customAgentDef({ bin: 'my-agent', args: '--print', promptViaStdin: true });
  assert.deepEqual(
    stdinOnly.buildArgs({ prompt: 'P', ws: '/tmp/w', mcpConfigPath: '/tmp/w/mcp.json' }),
    ['--print'],
  );
});

test('配置合并：agent 段保留默认 custom', () => {
  const cfg = resolveHardwareConfig({ agent: { runtime: 'claude' } });
  assert.equal(cfg.agent.runtime, 'claude');
  assert.equal(cfg.agent.custom.name, '自定义 CLI');
  assert.equal(cfg.agent.custom.promptViaStdin, true);
});

test('MCP stdio 服务：握手与 tools/list', async () => {
  const server = path.join(ROOT, 'lib', 'agent', 'external', 'mcp-server.mjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mcp-'));
  const child = spawn(process.execPath, [server], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, IC_DATA_DIR: dataDir, IC_MCP_PROJECT_ID: 'test-project' },
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP 握手超时；stderr=' + err)), 8000);
      const check = () => {
        if (out.includes('"id":1') && out.includes('"id":2') && out.endsWith('\n')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', check);
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('MCP 服务提前退出：' + code + '；stderr=' + err));
      });
      check();
    });

    const lines = out.trim().split('\n').filter(Boolean);
    const responses = lines.map((line) => JSON.parse(line));
    const init = responses.find((r) => r.id === 1);
    const list = responses.find((r) => r.id === 2);
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(list.result.tools.length, TOOL_DEFINITIONS.length);
    assert.ok(list.result.tools.some((t) => t.name === 'get_project'));
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
