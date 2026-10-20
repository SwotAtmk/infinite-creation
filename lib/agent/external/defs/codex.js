import { MCP_SERVER_NAME } from './shared.js';

// Codex CLI：MCP 通过 -c 覆盖 TOML 配置；prompt 走 stdin。
export const codex = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  versionArgs: ['--version'],
  installUrl: 'https://developers.openai.com/codex/cli',
  promptViaStdin: true,
  mcpMode: 'flag',
  buildArgs({ nodeBin, mcpServer }) {
    return [
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c', `mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(nodeBin)}`,
      '-c', `mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify(mcpServer.args)}`,
    ];
  },
};
