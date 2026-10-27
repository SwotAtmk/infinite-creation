import { MCP_SERVER_NAME } from './shared.js';

// Gemini CLI：读取工作区 .gemini/settings.json；--allowed-mcp-server-names 放行。
export const gemini = {
  id: 'gemini',
  name: 'Gemini CLI',
  bin: 'gemini',
  versionArgs: ['--version'],
  installUrl: 'https://github.com/google-gemini/gemini-cli',
  promptViaStdin: true,
  mcpMode: 'workspace',
  env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
  buildArgs() {
    return ['--approval-mode', 'yolo', '--allowed-mcp-server-names', MCP_SERVER_NAME];
  },
};
