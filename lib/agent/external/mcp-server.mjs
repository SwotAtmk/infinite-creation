// 本项目领域工具的 MCP stdio 服务。
// 协议：newline-delimited JSON-RPC 2.0（stdin/stdout）。
// 注意：stdout 只能输出协议帧，所有日志必须走 stderr 或日志文件。
import fs from 'node:fs';
import readline from 'node:readline';
import { TOOL_DEFINITIONS, createToolRuntime, runTool } from '../tools.js';

const writeStdout = process.stdout.write.bind(process.stdout);
// 先重定向 console，再加载/执行任何会写日志的模块逻辑。
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.debug = (...args) => console.error(...args);

const projectId = process.env.IC_MCP_PROJECT_ID || '';
const jobId = process.env.IC_MCP_JOB_ID || '';
const chapter = process.env.IC_MCP_CHAPTER || '';
const renderDisabled = process.env.IC_MCP_RENDER_DISABLED === '1';
const logFile = process.env.IC_MCP_LOG_FILE || '';
const progressFile = process.env.IC_MCP_PROGRESS_FILE || '';
const abortFile = process.env.IC_MCP_ABORT_FILE || '';

function appendLog(line) {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + line + String.fromCharCode(10)); } catch {}
}

function progress(ev) {
  if (!progressFile) return;
  try { fs.appendFileSync(progressFile, JSON.stringify({ t: Date.now(), ...ev }) + String.fromCharCode(10)); } catch {}
}

function isAborted() {
  return !!abortFile && fs.existsSync(abortFile);
}

let ctx = null;
function getCtx() {
  if (ctx) return ctx;
  if (!projectId) throw new Error('缺少 IC_MCP_PROJECT_ID，无法初始化项目工具上下文');
  ctx = createToolRuntime({
    projectId,
    jobId,
    chapter,
    renderDisabled,
    isAborted,
    onProgress: (patch) => progress({
      kind: 'phase',
      phase: patch?.phase || '',
      detail: String(patch?.detail || '').slice(0, 500),
    }),
  });
  return ctx;
}

function send(msg) {
  try { writeStdout(JSON.stringify(msg) + String.fromCharCode(10)); } catch {}
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function truncate(value, max = 300) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const text = s == null ? '' : String(s);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function toContent(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && Array.isArray(result.images)) {
    const text = typeof result.text === 'string' ? result.text : JSON.stringify(result);
    const content = [{ type: 'text', text }];
    for (const img of result.images) {
      if (img && img.data && img.mimeType) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    }
    return content;
  }
  return [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }];
}

async function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  if (!name) {
    fail(id, -32602, 'tools/call 缺少 name');
    return;
  }
  const detail = truncate(args);
  progress({ kind: 'tool_start', tool: name, detail });
  appendLog('[工具调用] ' + name + ' ' + detail);
  try {
    const result = await runTool(getCtx(), name, args);
    const content = toContent(result);
    const text = content.find((c) => c.type === 'text')?.text || '';
    appendLog('[工具结果] ' + name + ': ' + truncate(text, 500) + (content.length > 1 ? ' [图片] ' + (content.length - 1) + ' 张' : ''));
    if (name === 'skill' && args.name) appendLog('[技能] 已加载技能：' + args.name);
    progress({ kind: 'tool_end', tool: name, ok: true });
    ok(id, { content });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    appendLog('[工具错误] ' + name + ': ' + msg);
    progress({ kind: 'tool_end', tool: name, ok: false, detail: msg });
    ok(id, { content: [{ type: 'text', text: '工具执行错误：' + msg }], isError: true });
  }
}

function handle(msg) {
  const id = msg?.id;
  const method = msg?.method;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    if (!isNotification) {
      ok(id, {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'infinite-creation', version: '1.0.0' },
      });
    }
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') {
    if (!isNotification) ok(id, {});
    return;
  }
  if (method === 'tools/list') {
    if (!isNotification) {
      ok(id, {
        tools: TOOL_DEFINITIONS.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          inputSchema: t.function.parameters,
        })),
      });
    }
    return;
  }
  if (method === 'tools/call') {
    if (!isNotification) callTool(id, msg.params);
    return;
  }
  if (!isNotification) fail(id, -32601, 'Method not found: ' + method);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    fail(null, -32700, 'Parse error');
    return;
  }
  if (Array.isArray(msg)) {
    for (const one of msg) handle(one);
    return;
  }
  handle(msg);
});
rl.on('close', () => process.exit(0));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
