// Grok Build：读取工作区 .grok/config.toml；-p 单轮无头。
export const grok = {
  id: 'grok',
  name: 'Grok Build (xAI)',
  bin: 'grok',
  versionArgs: ['--version'],
  installUrl: 'https://x.ai/cli',
  promptViaStdin: false,
  mcpMode: 'workspace',
  buildArgs({ prompt }) {
    return ['-p', prompt];
  },
};
