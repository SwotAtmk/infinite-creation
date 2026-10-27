// Qoder CLI：读取工作区 .qoder/settings.json；-p - 从 stdin 读 prompt。
export const qoderCli = {
  id: 'qoder-cli',
  name: 'Qoder CLI',
  bin: 'qodercli',
  versionArgs: ['-v'],
  installUrl: 'https://www.npmjs.com/package/@qoder-ai/qodercli',
  promptViaStdin: true,
  mcpMode: 'workspace',
  buildArgs() {
    return ['-p', '-', '--permission-mode', 'bypass_permissions', '--dangerously-skip-permissions'];
  },
};
