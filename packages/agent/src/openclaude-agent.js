import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, Chapters, Jobs, projectDir } from '@ic/core';
import { query, tool, createSdkMcpServer } from '../../../vendor/openclaude/dist/sdk.mjs';
import { TOOL_DEFINITIONS, createToolRuntime, runTool } from './tools.js';
import { buildSystemPrompt } from './agent-loop.js';

// 禁用 openclaude 自带的文件系统/子代理/联网工具，强制走本工程 ComfyUI 领域工具，
// 避免 Agent 用 Bash/find 漫无目的地探索文件系统或联网搜索。
const DISALLOWED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'RepoMap', 'snip',
  'Task', 'TaskOutput', 'TaskStop',
  'WebFetch', 'WebSearch',
  'CronCreate', 'CronDelete', 'CronList',
  'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree',
  'AskUserQuestion',
  // 关键：禁用 openclaude 原生 Skill/DiscoverSkills（它们找不到本工程 skills/ 目录，会静默回退到
  // 内嵌摘要），强制 Agent 走本工程的 skill 工具（loadSkillWithResources 真正加载 skills/ 全文）。
  'Skill', 'DiscoverSkills',
];

// =============================================================================
// openclaude（@gitlawb/openclaude）作为 Agent 运行时：用 SDK 的 query() 在进程内驱动
// 小说→视频流水线。工具经 MCP「sdk」类型内嵌注册，处理器直接调用本工程的 runTool
// （ComfyUI + 数据库），无需 HTTP 往返。
// =============================================================================

// 从本工程 config.json 的 llm 配置映射为 openclaude 的 OpenAI 兼容 provider 环境变量
function providerEnv(cfg) {
  return {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_API_KEY: cfg.llm?.apiKey || '',
    OPENAI_BASE_URL: cfg.llm?.baseUrl || 'https://api.openai.com/v1',
    OPENAI_MODEL: cfg.llm?.model || 'deepseek-v4-flash-vision-exp',
    // 全自动「小说→视频」流水线会产生大量工具调用（几百条消息），
    // openclaude 默认 active-message 阈值仅 200 / 硬上限 1000，太小会提前触发
    // "over the active-message safety limit" 停跑。这里放宽到 1500 / 4000 留足余量，
    // token 侧的自动压缩仍按原阈值工作，不会失控。
    OPENCLAUDE_MAX_ACTIVE_MESSAGES: '1500',
    OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP: '4000',
  };
}

// 每个 job 一份详细日志文件：data/projects/<id>/logs/<jobId>.log
// 记录 Agent 的每一步工具调用/结果、技能加载、进度、最终结果，供排查与回看。
function createAgentLog(projectId, jobId) {
  const dir = path.join(projectDir(projectId), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const file = path.join(dir, jobId + '.log');
  const append = (line) => {
    const t = new Date().toISOString();
    try { fs.appendFileSync(file, '[' + t + '] ' + line + String.fromCharCode(10)); } catch {}
  };
  return { file, append };
}

// 把 TOOL_DEFINITIONS（OpenAI function-calling 格式）转成 openclaude 的 MCP 工具定义。
// 每个工具绑定当前 projectId，处理器直接调用本工程 runTool（复用全部现有逻辑）。
function buildMcpTools({ projectId, jobId, chapter, report, logAppend, isAborted }) {
  return TOOL_DEFINITIONS.map((t) => {
    const { name, description, parameters } = t.function;
    return tool(name, description, parameters, async (args) => {
      const ctx = createToolRuntime({ projectId, jobId, chapter, onProgress: report, isAborted });
      try {
        const result = await runTool(ctx, name, args || {});
        // 结构化结果（{ text, images }）→ 文本块 + 图片块（MCP image 格式，openclaude 自动缩放并转 image_url）
        if (result && typeof result === 'object' && !Array.isArray(result) && Array.isArray(result.images) && result.images.length) {
          const text = typeof result.text === 'string' ? result.text : JSON.stringify(result);
          const short = text.length > 500 ? text.slice(0, 500) + '…' : text;
          logAppend('[工具结果] ' + name + ': ' + short + ' [图片] ' + result.images.length + ' 张');
          const content = [{ type: 'text', text }];
          for (const img of result.images) {
            if (img && img.data && img.mimeType) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
          }
          return { content };
        }
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        const short = text.length > 500 ? text.slice(0, 500) + '…' : text;
        logAppend('[工具结果] ' + name + ': ' + short);
        if (name === 'skill' && args && args.name) logAppend('[技能] 已加载技能：' + args.name);
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        logAppend('[工具错误] ' + name + ': ' + msg);
        return { content: [{ type: 'text', text: '工具执行错误：' + msg }], isError: true };
      }
    });
  });
}

// 构造用户任务提示词（与自研 runAgentLoop 的 seed 一致，保证续跑语义相同）
function buildTaskPrompt(ctx) {
  let chapters = Chapters.list(ctx.projectId).map((c) => ({ id: c.id, title: c.title, novel: c.novel }));
  const target = ctx.chapter || '';
  if (target) chapters = chapters.filter((c) => c.title === target || c.id === target);
  const seed = JSON.stringify({
    project: { name: ctx.project.name, style: ctx.project.style, idea: ctx.project.idea || '' },
    targetChapter: target || null,
    chapters,
    novel: chapters.map((c) => c.novel).join('\n\n').slice(0, 6000),
  });
  return '开始执行：请把下面的项目完成到成片导出。\n' + seed;
}

// 运行一次 openclaude Agent，流式产出进度，返回最终结果文本。
export async function runOpenClaudeAgent({ projectId, chapter, jobId, onProgress, isAborted }) {
  const cfg = loadConfig();
  const ctx = createToolRuntime({ projectId, jobId, chapter, onProgress, isAborted });
  const systemPrompt = buildSystemPrompt({ ctx, skillName: 'novel-to-video' });
  const prompt = buildTaskPrompt(ctx);

  // 详细日志：每个 job 一份文件，并回写 jobs.log_path 供前端读取
  const log = createAgentLog(projectId, jobId);
  const logAppend = log.append;
  try { Jobs.update(jobId, { logPath: log.file }); } catch {}
  // report：既写日志，也上报进度（Web 界面）
  const report = (patch) => {
    logAppend('[进度]' + (patch.phase ? ' [' + patch.phase + ']' : '') + (patch.detail ? ' ' + patch.detail : ''));
    if (onProgress) onProgress(patch);
  };

  logAppend('==== 任务开始 ====');
  logAppend('project=' + projectId + ' chapter=' + (chapter || '全部') + ' model=' + (cfg.llm?.model || ''));

  const tools = buildMcpTools({ projectId, jobId, chapter, report, logAppend, isAborted });

  const env = providerEnv(cfg);
  // 兜底：部分 provider 读取 process.env，同时注入进程环境
  for (const k of Object.keys(env)) process.env[k] = env[k];

  const q = query({
    prompt,
    options: {
      cwd: process.cwd(),
      model: env.OPENAI_MODEL,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      disallowedTools: DISALLOWED_TOOLS,
      canUseTool: async (toolName) => {
        // 全自动流水线：禁止向用户提问，其余工具一律放行
        if (toolName === 'AskUserQuestion') return { behavior: 'deny', message: '全程自主决策，禁止询问用户' };
        return { behavior: 'allow' };
      },
      systemPrompt: { type: 'custom', content: systemPrompt },
      mcpServers: { infinite_creation: createSdkMcpServer({ type: 'sdk', name: 'infinite_creation', tools }) },
      env,
    },
  });

  let lastText = '';
  try {
    for await (const msg of q) {
      if (isAborted && isAborted()) {
        try { q.interrupt(); } catch {}
        logAppend('[停止] 任务已停止');
        throw new Error('任务已停止');
      }
      // 每一步工具调用/模型输出都写入日志，并播报给 Web 界面
      if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
        for (const b of msg.message.content) {
          if (b && b.type === 'tool_use') {
            const detail = JSON.stringify(b.input || {});
            const short = detail.length > 300 ? detail.slice(0, 300) + '…' : detail;
            logAppend('[工具调用] ' + b.name + ' ' + short);
            report({ phase: 'tool:' + b.name, detail: short });
          } else if (b && b.type === 'text' && b.text) {
            logAppend('[模型输出] ' + b.text.slice(0, 800));
          }
        }
      }
      if (msg.type === 'result') {
        if (msg.subtype === 'success') { lastText = msg.result || lastText; logAppend('[结果] ' + String(lastText).slice(0, 2000)); }
        if (msg.is_error) { logAppend('[失败] ' + (msg.result || '未知错误')); throw new Error('Agent 运行失败：' + (msg.result || '未知错误')); }
      }
    }
    logAppend('==== 任务结束 ====');
  } catch (e) {
    logAppend('[异常] ' + (e && e.message ? e.message : String(e)));
    throw e;
  }
  return lastText;
}
