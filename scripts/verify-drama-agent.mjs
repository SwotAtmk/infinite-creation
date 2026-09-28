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
    const ctx = createToolRuntime({ projectId: PID, jobId: 'verify', chapter: '', onProgress: () => {}, isAborted: () => false });
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
  prompt: '请依次执行两步并用中文总结（引用技能/参考文件的具体内容）：1) 调用 skill(name="0715-scriptwriter") 加载短剧编剧技能，总结它对「短剧编剧」的核心规范；2) 调用 skill_reference(name="script-master", ref="framework.md") 读取剧本框架参考文件，总结其「项目档案生成」的要点。',
  options: {
    cwd: process.cwd(),
    model: env.OPENAI_MODEL,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    canUseTool: async () => ({ behavior: 'allow' }),
    systemPrompt: { type: 'custom', content: '你是短剧/漫剧创作专家。必须先调用 skill 与 skill_reference 工具加载技能/参考文件全文，再严格引用其中规范回答。' },
    mcpServers: { ic: createSdkMcpServer({ type: 'sdk', name: 'ic', tools }) },
    env,
  },
});

try {
  for await (const msg of q) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const b of msg.message.content) {
        if (b.type === 'tool_use') console.log('TOOL_USE:', b.name, JSON.stringify(b.input || {}).slice(0, 80));
        if (b.type === 'text') console.log('TEXT:', b.text.slice(0, 200));
      }
    } else if (msg.type === 'result') {
      console.log('RESULT:', msg.subtype, JSON.stringify(msg.result || '').slice(0, 1500));
    }
  }
} catch (e) {
  console.log('QUERY ERROR:', e.message);
}
console.log('=== DONE ===');
