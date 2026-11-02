// Agent 运行时选择：内置 openclaude（默认）或本机外部 CLI。
import { loadConfig, logger } from '../core/index.js';
import { runOpenClaudeAgent, runOpuscarOpenClaudeAgent } from './openclaude-agent.js';
import { findAgentDef, runExternalAgent } from './external/index.js';

export async function runAgent(opts) {
  const runtime = String(loadConfig().agent?.runtime || 'openclaude');
  if (runtime === 'openclaude') return runOpenClaudeAgent(opts);
  if (runtime === 'custom' || findAgentDef(runtime)) {
    return runExternalAgent({ ...opts, agentId: runtime });
  }
  logger.warn('agent: 未知的 runtime，回退内置 openclaude', { runtime });
  return runOpenClaudeAgent(opts);
}

// 「无限・秩影」运行时选择：与 runAgent 同构，但走 opuscar 专属会话。
export async function runOpuscarAgent(opts) {
  const runtime = String(loadConfig().agent?.runtime || 'openclaude');
  if (runtime === 'openclaude') return runOpuscarOpenClaudeAgent(opts);
  if (runtime === 'custom' || findAgentDef(runtime)) {
    return runExternalAgent({ ...opts, agentId: runtime, opuscar: true });
  }
  logger.warn('agent: 未知的 runtime，回退内置 openclaude（opuscar）', { runtime });
  return runOpuscarOpenClaudeAgent(opts);
}
