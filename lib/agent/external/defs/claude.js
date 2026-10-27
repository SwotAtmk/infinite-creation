import path from 'node:path';

// Claude Code：--mcp-config 指向工作区 JSON；--print 无头模式；禁用文件/命令类工具。
export const claude = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  versionArgs: ['--version'],
  installUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
  promptViaStdin: true,
  mcpMode: 'flag',
  buildArgs({ ws }) {
    return [
      '--print',
      '--mcp-config', path.join(ws, 'claude-mcp.json'),
      '--strict-mcp-config',
      '--dangerously-skip-permissions',
      '--disallowedTools', 'Bash,Read,Write,Edit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task',
    ];
  },
};
