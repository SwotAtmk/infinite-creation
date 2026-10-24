// OpenCode V2：读取工作区 opencode.json 的 mcp.servers；run 无头执行。
// 必须 --standalone：共享后台服务不继承本任务的 IC_MCP_* 环境变量，MCP 会拿不到任务上下文。
// prompt 走 argv（run 只接受位置参数 message），Windows 下超长 prompt 受命令行长度限制，runner 会记提示。
export const opencode = {
  id: 'opencode',
  name: 'OpenCode',
  bin: 'opencode',
  versionArgs: ['--version'],
  installUrl: 'https://opencode.ai/v2/docs/',
  promptViaStdin: false,
  mcpMode: 'workspace',
  buildArgs({ prompt }) {
    return ['run', '--standalone', '--auto', prompt];
  },
};
