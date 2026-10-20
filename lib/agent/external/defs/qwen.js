import { MCP_SERVER_NAME } from './shared.js';

// Qwen Code：Gemini CLI 的分支，工作区 .qwen/settings.json。
export const qwen = {
  id: 'qwen',
  name: 'Qwen Code',
  bin: 'qwen',
  versionArgs: ['--version'],
  installUrl: 'https://github.com/QwenLM/qwen-code',
  promptViaStdin: true,
  mcpMode: 'workspace',
  env: { GEMINI_CLI_TRUST_WORKSPACE: 'true', QWEN_CLI_TRUST_WORKSPACE: 'true' },
  buildArgs() {
    return ['--approval-mode', 'yolo', '--allowed-mcp-server-names', MCP_SERVER_NAME];
  },
};
