// Cursor Agent：读取工作区 .cursor/mcp.json；--print 无头。
export const cursorAgent = {
  id: 'cursor-agent',
  name: 'Cursor Agent',
  bin: 'cursor-agent',
  versionArgs: ['--version'],
  installUrl: 'https://cursor.com/cli',
  promptViaStdin: true,
  mcpMode: 'workspace',
  buildArgs() {
    return ['--print', '--force', '--approve-mcps'];
  },
};
