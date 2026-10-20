import { claude } from './defs/claude.js';
import { codex } from './defs/codex.js';
import { gemini } from './defs/gemini.js';
import { qwen } from './defs/qwen.js';
import { cursorAgent } from './defs/cursor-agent.js';
import { qoderCli } from './defs/qoder.js';
import { grok } from './defs/grok.js';
import { hermes } from './defs/hermes.js';

// 内置外部 Agent 定义，顺序即设置页下拉顺序。
// 每个 Agent 独立一个文件（defs/<id>.js），新增 Agent 时：写定义 + 在这里登记。
export const AGENT_DEFS = [claude, codex, gemini, qwen, cursorAgent, qoderCli, grok, hermes];

export function findAgentDef(id) {
  return AGENT_DEFS.find((d) => d.id === id);
}
