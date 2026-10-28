import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, Chapters, Jobs, Assets, ReferenceImages, projectDir, resolveProjectPath, imageToDataUrl, buildVisionContentBlocks, openaiCompatBaseUrl } from '../core/index.js';
import { AGENT_WATCHDOG, watchdogStep, watchdogStallCheck, filterReferenceImages } from '../shared/index.js';
import { query, tool, createSdkMcpServer } from '../../vendor/openclaude/dist/sdk.mjs';
import { TOOL_DEFINITIONS, createToolRuntime, runTool, visionEnabled, targetChapterIdSet, IMAGE_ASSET_CATEGORIES } from './tools.js';
import { buildSystemPrompt, buildTaskPrompt } from './agent-loop.js';
import { acquireAgentSlot, agentConcurrency, agentQueueTimeoutMs } from './agent-gate.js';

// 工具 → 人类可读的当前步骤（用于任务/活动面板显示“正在执行哪个工具”）
const TOOL_LABELS = {
  get_project: '读取项目', list_assets: '读取资产', list_chapters: '读取章节', list_shots: '读取分镜',
  create_asset: '创建资产', update_asset: '更新资产', set_storyboard: '写入分镜',
  update_shot: '更新分镜提示词', save_context: '保存上下文',
  skill: '加载技能', skill_reference: '读取技能参考',
  view_asset: '查看参考图', view_shot_references: '查看分镜参考', view_project_references: '查看项目参考',
  generate_asset_image: '生成资产图', edit_asset_image: '编辑资产图',
  generate_assets_batch: '批量生成资产', design_voice: '设计音色',
  change_outfit: '生成服装', design_outfits: '设计服装', change_age: '生成年龄变体', design_ages: '设计年龄变体',
  generate_shot_video: '生成分镜视频', regenerate_shot: '重新生成分镜',
  generate_chapter_videos: '批量生成分镜视频', assemble_video: '合成成片',
  set_chapter_music: '写背景音乐描述', generate_music: '生成背景音乐', apply_chapter_music: '应用背景音乐',
  generate_music_asset: '生成音乐素材', generate_asset_from_reference: '参考图生成素材',
  list_workflows: '读取工作流', register_voice: '登记音色', report: '汇报进度',
};

// 禁用 openclaude 自带的全部「运行时」工具（执行命令/读写文件/子代理/联网/定时/协作/监控等），
// 强制走本工程经 MCP 注册的领域工具。
//
// 名字按 openclaude 真实注册名逐一核对（vendor/openclaude/src/tools/*）：Windows 上的 shell
// 工具是 PowerShell 而不是 Bash，子代理工具是 Agent 而不是 Task，Monitor 就是「跑任意 shell
// 命令 + 轮询输出」——漏一个就等于把命令执行能力交给模型（曾发生：模型用未禁用的 Monitor 起了
// 一个后台 shell 任务去拉服务，任务 id 前缀 'b' 即 local_bash）。
//
// 注意：disallowedTools 只在「建工具池」时静态过滤一次（bypassPermissions 下运行时不再校验，
// 见 vendor/.../entrypoints/sdk/permissions.ts）。因此它只是第一道，真正的运行时闸门是下面的
// canUseTool 白名单（DOMAIN_TOOLS / isAllowedTool）。
const DISALLOWED_TOOLS = [
  // 执行命令 / 读写文件 / 代码
  'Bash', 'PowerShell', 'REPL', 'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep', 'RepoMap', 'snip', 'LSP', 'ctx_inspect',
  // 子代理 / 任务 / 协作
  'Agent', 'Task', 'TaskOutput', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
  'TeamCreate', 'TeamDelete', 'SendMessage', 'SendUserMessage', 'SendUserFile', 'Sleep',
  // 联网 / 浏览器
  'WebFetch', 'WebSearch',
  // 定时 / 模式 / 工作树
  'CronCreate', 'CronDelete', 'CronList',
  'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree',
  // 后台 shell 任务 / 终端 / 工作流 / 监控（Monitor = 任意 shell 命令 + 输出轮询）
  'Monitor', 'TerminalCapture', 'RemoteTrigger', 'WorkflowTool',
  // 提权 / 审批 / 杂项
  'AskUserQuestion', 'Brief', 'TodoWrite', 'OverflowTest', 'ReviewArtifact',
  'VerifyPlanExecution', 'StructuredOutput', 'ListMcpResourcesTool',
  // 原生 Skill/DiscoverSkills：它们找不到本工程 skills/ 目录，会静默回退到内嵌摘要，
  // 强制 Agent 走本工程的 skill 工具（loadSkillWithResources 真正加载 skills/ 全文）。
  'Skill', 'DiscoverSkills',
];

// 运行时白名单：只放行本工程经 MCP 注册的领域工具（TOOL_DEFINITIONS 的名字）。
// SDK 对每一次工具调用都会调用 canUseTool（createDefaultCanUseTool 注释：SDK 消费者必须显式
// 提供权限回调，工具才会执行），所以这里是最后一道、也是唯一不依赖「工具名清单写全」的闸门：
// 无论 DISALLOWED_TOOLS 漏了什么、子代理/插件又带进来什么，不在这份白名单里就拒绝执行。
// ToolSearch 单独放行：本工程 30+ 个 MCP 工具会被延迟注册，模型要靠它按名字选出来。
const DOMAIN_TOOLS = new Set(TOOL_DEFINITIONS.map((t) => t.function.name));
function isAllowedTool(toolName) {
  if (toolName === 'ToolSearch') return true;
  if (DOMAIN_TOOLS.has(toolName)) return true;
  // MCP 工具在非 skip-prefix 模式下可能带 mcp__<server>__ 前缀
  const i = toolName.lastIndexOf('__');
  if (i > 0 && toolName.startsWith('mcp__')) return DOMAIN_TOOLS.has(toolName.slice(i + 2));
  return false;
}

// =============================================================================
// openclaude（@gitlawb/openclaude）作为 Agent 运行时：用 SDK 的 query() 在进程内驱动
// 小说→视频流水线。工具经 MCP「sdk」类型内嵌注册，处理器直接调用本工程的 runTool
// （ComfyUI + 数据库），无需 HTTP 往返。
// =============================================================================

// 从本工程 config.json 的 llm 配置映射为 openclaude 的 OpenAI 兼容 provider 环境变量
function providerEnv(cfg) {
  // 兜底：openclaude SDK 内部某些分支（例如续跑/压缩消息时重新 init client）
  // 会在路由未明确走 OpenAI shim 时 fallback 到 Anthropic 原生构造函数，
  // 然后在 getAnthropicApiKeyWithSource 里 throw。为了让这些意外分支也能工作，
  // 给 ANTHROPIC_API_KEY 塞一个占位值——只要 CLAUDE_CODE_USE_OPENAI=1 生效就会走 OpenAI，
  // 这个占位值永远不会被真正用来发请求。
  const env = {
    CLAUDE_CODE_USE_OPENAI: '1',
    // 告诉 SDK：推理路由由宿主（本工程）决定，settings.json 里的 provider env 不得覆盖。
    // 这样下面把 env 一次性写进 process.env 后，init() 不会再把 OpenAI shim 顶掉。
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    OPENAI_API_KEY: cfg.llm?.apiKey || '',
    ANTHROPIC_API_KEY: 'openai-shim-placeholder',
    // 必须走 openaiCompatBaseUrl 归一化（与 llmEndpoint / 预检同一套 /v1 规则）：
    // openclaude 的 OpenAI SDK 只会在 base 后拼 '/chat/completions'，不做 /v1 补全。
    OPENAI_BASE_URL: openaiCompatBaseUrl(cfg.llm?.baseUrl || 'https://api.openai.com/v1'),
    OPENAI_MODEL: cfg.llm?.model || 'deepseek-v4-flash-vision-exp',
    // 全自动「小说→视频」流水线会产生大量工具调用（几百条消息），
    // openclaude 默认 active-message 阈值仅 200 / 硬上限 1000，太小会提前触发
    // "over the active-message safety limit" 停跑。这里放宽到 1500 / 4000 留足余量，
    // token 侧的自动压缩仍按原阈值工作，不会失控。
    OPENCLAUDE_MAX_ACTIVE_MESSAGES: '1500',
    OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP: '4000',
  };
  return env;
}

// 把 provider 配置写入进程环境，但**不要**再作为 query({env}) 传入。
// SDK 只要收到 env overrides，就会在 query.ts 里 acquireEnvMutex() 并持有到整个 query 结束，
// 同一进程内的第二个 agent 会一直卡在「读取项目」（20 分钟后被看门狗误杀）。
// 本工程的 LLM 配置是全局一份，写一次 process.env 即可让多个 query 真正并行。
function applyProviderEnv(cfg) {
  const env = providerEnv(cfg);
  for (const key of Object.keys(env)) process.env[key] = env[key];
  return env;
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
function buildMcpTools({ projectId, jobId, chapter, report, logAppend, isAborted, renderDisabled }) {
  return TOOL_DEFINITIONS.map((t) => {
    const { name, description, parameters } = t.function;
    return tool(name, description, parameters, async (args) => {
      // 把“当前正在调用哪个工具”写进 job.phase/detail：两个章节并行时，活动面板能看出各自跑到哪一步。
      if (name !== 'report') {
        let detail = '';
        try { detail = JSON.stringify(args || {}).slice(0, 160); } catch { /* 忽略 */ }
        report({ phase: TOOL_LABELS[name] || name, detail });
      }
      // renderDisabled 必须一路带到工具运行时：runTool 的渲染硬拦靠的是 ctx.renderDisabled，
      // 早期遗漏导致「只跑 LLM 文本」的批次（如 regenerate?mode=full）照样能提交 ComfyUI 渲染。
      const ctx = createToolRuntime({ projectId, jobId, chapter, onProgress: report, isAborted, renderDisabled });
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

// 读取两类「用户上传的图」并转为视觉图片块（≤2.5MB/张），随首条消息一并喂给 Agent：
// ① mode=reference（参考生成新素材）：作为图生图(i2i)参考输入，据此派生新素材；
// ② source=uploaded 且有 image_path（导入素材库）：分析后绑定到合适分镜。
const REFERENCE_INSTRUCTION = `

【参考生成新素材（图生图）】用户本次上传了参考图片素材（已随本条消息附带图片，并给出 reference_id）。请先用视觉能力逐张分析这些参考图的内容、画面风格、角色/场景/道具等元素。当故事情节需要生成与某张参考图相关的素材时，用 generate_asset_from_reference(reference_id=该图id, category, name, prompt, description) 以该参考图为图生图(i2i)输入，派生一张风格/设定一致的新图，并把它作为素材放进合适分镜（set_storyboard 按名字引用）。没有对应参考图的、纯按文字描述的新素材才走 generate_assets_batch 文生图。参考图本身不要直接当成品，而是作为图生图输入派生新图。`;

const IMPORT_INSTRUCTION = `

【导入素材库（分析后绑定分镜）】用户本次还上传了「导入素材库」的图（已随本条消息附带图片，并给出 asset_id 与分类）。请先用视觉能力逐张分析每张图适合出现在哪个分镜：人物→characters、场景/环境→scenes、道具/物品→props，然后在拆分镜写 set_storyboard 时按名字把它们绑定到合适分镜，禁止忽略或为同一主体重复生成同义资产。对 category=other 的导入素材，先分析后归入合适分类或作为风格/元素参考使用。`;

function buildUploadedBlocks(ctx) {
  const refs = filterReferenceImages(ReferenceImages.list(ctx.projectId, { mode: 'reference' }), targetChapterIdSet(ctx));
  const imported = Assets.list(ctx.projectId).filter((a) => (a.source || '') === 'uploaded' && a.image_path && IMAGE_ASSET_CATEGORIES.includes(a.category));

  const images = [];
  const refLines = [];
  const importLines = [];
  let ri = 0;
  for (const r of refs) {
    const abs = resolveProjectPath(ctx.projectId, r.image_path);
    const img = imageToDataUrl(abs, { maxBytes: 2.5 * 1024 * 1024 });
    if (!img) continue;
    ri += 1;
    images.push(img);
    const parts = ['参考图' + ri + '（reference_id=' + r.id + '）：' + (r.name || '未命名')];
    if (r.description) parts.push('用途/剧情定位：' + r.description);
    refLines.push(parts.join('；'));
  }
  let ii = 0;
  for (const a of imported) {
    const abs = resolveProjectPath(ctx.projectId, a.image_path);
    const img = imageToDataUrl(abs, { maxBytes: 2.5 * 1024 * 1024 });
    if (!img) continue;
    ii += 1;
    images.push(img);
    const parts = ['导入素材' + ii + '（asset_id=' + a.id + '，分类=' + a.category + '）：' + (a.name || '未命名')];
    if (a.description) parts.push('用途/剧情定位：' + a.description);
    importLines.push(parts.join('；'));
  }
  return { refs, imported, images, refText: refLines.join('\n'), importText: importLines.join('\n') };
}

// 运行一次 openclaude Agent，流式产出进度，返回最终结果文本。
// renderDisabled=true 表示本批只跑 LLM 文本（ComfyUI 未启动），渲染工具会被 runTool 拦掉。
export async function runOpenClaudeAgent({ projectId, chapter, jobId, onProgress, isAborted, renderDisabled }) {
  const cfg = loadConfig();
  const ctx = createToolRuntime({ projectId, jobId, chapter, onProgress, isAborted, renderDisabled });
  const systemPrompt = buildSystemPrompt({ ctx, skillName: 'novel-to-video' });
  const basePrompt = buildTaskPrompt(ctx);

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

  const tools = buildMcpTools({ projectId, jobId, chapter, report, logAppend, isAborted, renderDisabled });

  // 只写进程环境，不再把 env 传给 query()：否则 SDK 的进程级 env mutex 会把
  // 同一进程里的多个 agent 串行化（第二个一直停在「读取项目」）。
  const env = applyProviderEnv(cfg);

  // 进程级 Agent 槽位：多个章节并行时限制真正同时运行的 Agent 数，
  // 超出的任务停在「等待 Agent 槽位」，不会触发模型停滞看门狗。
  let releaseSlot = null;
  try {
    releaseSlot = await acquireAgentSlot({
      limit: agentConcurrency(cfg),
      waitMaxMs: agentQueueTimeoutMs(cfg),
      isAborted,
      onWait: ({ active, waiting, limit }) => report({
        phase: '等待 Agent 槽位',
        detail: '当前 ' + active + '/' + limit + ' 个会话运行中，前面还有 ' + Math.max(0, waiting - 1) + ' 个任务等待',
      }),
    });
    // 拿到槽位后才进入真正的模型读取阶段。
    report({ phase: '读取项目', detail: '加载技能与项目上下文' });

    // 参考图读取也放在拿到槽位之后：排队中的任务不提前占内存。
    let prompt = basePrompt;
    if (visionEnabled(ctx)) {
      const { refs, imported, images, refText, importText } = buildUploadedBlocks(ctx);
      if (images.length) {
        let text = basePrompt;
        if (refs.length && refText) text += REFERENCE_INSTRUCTION + '\n\n【参考图用途/剧情定位】\n' + refText;
        if (imported.length && importText) text += IMPORT_INSTRUCTION + '\n\n【导入素材清单】\n' + importText;
        prompt = [{ message: { role: 'user', content: buildVisionContentBlocks(text, images) } }];
      }
    }

    const q = query({
    prompt,
    options: {
      cwd: process.cwd(),
      model: env.OPENAI_MODEL,
      // fullAccess（而不是 bypassPermissions）：SDK 只在 fullAccess 下会先跑 hasPermissionsToUseTool
      // 校验 deny 规则（entrypoints/sdk/permissions.ts），bypassPermissions 会把 deny 规则彻底跳过。
      permissionMode: 'fullAccess',
      allowDangerouslySkipPermissions: true,
      disallowedTools: DISALLOWED_TOOLS,
      canUseTool: async (toolName) => {
        // 白名单闸门：只放行本工程领域工具（含 ToolSearch），其余一律拒绝。
        // 全自动流水线本来也不允许向用户提问 —— AskUserQuestion 不在白名单内，自然被拒。
        if (!isAllowedTool(toolName)) {
          return { behavior: 'deny', message: '本工程只允许领域工具，禁止执行命令/读写文件/联网等运行时工具：' + toolName };
        }
        return { behavior: 'allow' };
      },
      systemPrompt: { type: 'custom', content: systemPrompt },
      mcpServers: { infinite_creation: createSdkMcpServer({ type: 'sdk', name: 'infinite_creation', tools }) },
    },
  });

  let lastText = '';
  // 看门狗：防「模型输出被截断/上游停滞后任务永远 running、界面一直显示停止按钮」。
  // - 消息驱动的 watchdogStep：每条消息到达时判停滞/截断熔断（截断熔断依赖消息内容，必须在此）；
  // - 定时器 watchdogStallCheck：for await 阻塞等待上游消息不产出时，停滞判定也要能触发
  //   （工具执行窗口 pendingTools>0 会被豁免，不误杀长时渲染）。
  // 触发后调用 q.interrupt() 中断查询，再抛错让 job 以 failed 收尾、界面恢复。
  let watchdog = { lastAt: Date.now(), pendingTools: 0, truncStreak: 0 };
  let watchdogHalted = null; // 定时器触发的停滞（异步中断，稍后在循环里抛出）
  // config.generation.agentStallMinutes 可覆盖默认停滞阈值（分钟），适配慢速本地模型
  const stallMs = Number(cfg.generation?.agentStallMinutes) > 0
    ? Number(cfg.generation.agentStallMinutes) * 60 * 1000
    : AGENT_WATCHDOG.STALL_MS;
  const failWatchdog = (reason) => {
    logAppend('[看门狗] ' + reason);
    try { q.interrupt(); } catch {}
    throw new Error(reason);
  };
  const stallTimer = setInterval(() => {
    if (watchdogHalted) return;
    const halted = watchdogStallCheck(watchdog, Date.now(), stallMs);
    if (halted) {
      watchdogHalted = halted;
      try { q.interrupt(); } catch {}
    }
  }, AGENT_WATCHDOG.CHECK_INTERVAL_MS);
  try {
    for await (const msg of q) {
      // 停滞/截断熔断检查（消息驱动）：工具执行窗口（上一条是 tool_use）不做停滞判定，
      // 避免误杀长时渲染；截断纯文本连续出现则熔断，避免 20 次 nudge 空转。
      const step = watchdogStep(watchdog, msg, Date.now(), stallMs);
      watchdog = step.next;
      if (step.halted) failWatchdog(step.halted);
      if (watchdogHalted) failWatchdog(watchdogHalted);
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
    clearInterval(stallTimer);
    if (watchdogHalted) throw new Error(watchdogHalted);
    logAppend('==== 任务结束 ====');
  } catch (e) {
    clearInterval(stallTimer);
    if (watchdogHalted) {
      logAppend('[异常] ' + watchdogHalted);
      throw new Error(watchdogHalted);
    }
    logAppend('[异常] ' + (e && e.message ? e.message : String(e)));
    throw e;
  }
  return lastText;
  } finally {
    if (releaseSlot) releaseSlot();
  }
}
