import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/core/index.js';
import { detectAll, mcpServerSpec } from '@/lib/agent/external/index.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const force = new URL(req.url).searchParams.get('force') === '1';
  const cfg = loadConfig();
  const agents = await detectAll({ force, extraPath: cfg.agent?.extraPath || '' });
  const spec = mcpServerSpec();
  return NextResponse.json({
    runtime: cfg.agent?.runtime || 'openclaude',
    custom: cfg.agent?.custom || {},
    mcpServer: {
      command: spec.command,
      args: spec.args,
      env: [
        'IC_MCP_PROJECT_ID',
        'IC_MCP_JOB_ID',
        'IC_MCP_CHAPTER',
        'IC_MCP_RENDER_DISABLED',
        'IC_MCP_LOG_FILE',
        'IC_MCP_PROGRESS_FILE',
        'IC_MCP_ABORT_FILE',
      ],
    },
    agents: [
      { id: 'openclaude', name: '内置 openclaude', bin: '', available: true, builtin: true, path: '', version: null, installUrl: '' },
      ...agents,
    ],
  });
}
