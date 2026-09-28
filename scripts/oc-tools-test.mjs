import { loadConfig } from '../lib/core/index.js';
import { query, tool, createSdkMcpServer } from '../vendor/openclaude/dist/sdk.mjs';
import { TOOL_DEFINITIONS, createToolRuntime, runTool } from '../lib/agent/tools.js';

const PID = 'd51107dc-0bac-4315-8ebb-405679a8b3a9';
const cfg = loadConfig();
const env = {
  CLAUDE_CODE_USE_OPENAI: '1',
  OPENAI_API_KEY: cfg.llm.apiKey,
  OPENAI_BASE_URL: cfg.llm.baseUrl,
  OPENAI_MODEL: cfg.llm.model,
};

const tools = TOOL_DEFINITIONS.map((t) => {
  const { name, description, parameters } = t.function;
  return tool(name, description, parameters, async (args) => {
    const ctx = createToolRuntime({ projectId: PID, jobId: 'test', chapter: '', onProgress: () => {}, isAborted: () => false });
    try {
      const result = await runTool(ctx, name, args || {});
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: '工具执行错误：' + e.message }], isError: true };
    }
  });
});
console.log('tools:', tools.length);

const q = query({
  prompt: '先调用 skill(name="h3-prompt-writing") 加载技能全文，然后告诉我：该技能规定如何写 MiniMax H3 视频提示词？请引用技能里的具体规范。',
  options: {
    cwd: process.cwd(),
    model: env.OPENAI_MODEL,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    canUseTool: async () => ({ behavior: 'allow' }),
    systemPrompt: { type: 'custom', content: '你是视频提示词专家。必须先用 skill 工具加载技能全文，再严格引用技能规范回答。' },
    mcpServers: { ic: createSdkMcpServer({ type: 'sdk', name: 'ic', tools }) },
    env,
  },
});

try {
  for await (const msg of q) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const b of msg.message.content) {
        if (b.type === 'tool_use') console.log('TOOL_USE:', b.name, JSON.stringify(b.input||{}).slice(0,100));
        if (b.type === 'text') console.log('TEXT:', b.text.slice(0, 300));
      }
    } else if (msg.type === 'result') {
      console.log('RESULT:', msg.subtype, JSON.stringify(msg.result || '').slice(0, 1200));
    }
  }
} catch (e) {
  console.log('QUERY ERROR:', e.message);
}
console.log('=== DONE ===');
