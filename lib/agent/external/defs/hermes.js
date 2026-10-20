// Hermes：MCP 配置在 $HERMES_HOME/config.yaml；prompt 走 argv。
export const hermes = {
  id: 'hermes',
  name: 'Hermes (local CLI)',
  bin: 'hermes',
  versionArgs: ['version'],
  installUrl: 'https://hermes.agentinfo.dev',
  promptViaStdin: false,
  mcpMode: 'hermes-home',
  buildArgs({ prompt }) {
    return ['chat', '-Q', '-q', prompt];
  },
};
