import path from 'node:path';
import { parseCustomArgs } from './shared.js';

// 自定义 CLI：MCP 由用户自行接入；{mcpConfig} 会替换成工作区内的 mcp.json 路径。
export function customAgentDef(custom = {}) {
  const bin = String(custom.bin || '').trim();
  const promptViaStdin = custom.promptViaStdin !== false;
  const rawArgs = parseCustomArgs(custom.args);
  return {
    id: 'custom',
    name: String(custom.name || '自定义 CLI'),
    bin,
    versionArgs: ['--version'],
    installUrl: '',
    promptViaStdin,
    mcpMode: 'manual',
    buildArgs({ prompt, ws, mcpConfigPath }) {
      const cfgPath = mcpConfigPath || path.join(ws, 'mcp.json');
      let args = rawArgs.map((a) => a
        .replace(/\{prompt\}/g, prompt)
        .replace(/\{mcpConfig\}/g, cfgPath));
      const hasPromptSlot = rawArgs.some((a) => a.includes('{prompt}'));
      if (!hasPromptSlot && !promptViaStdin) args = [...args, prompt];
      return args;
    },
  };
}
