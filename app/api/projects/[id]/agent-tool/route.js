// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { createToolRuntime, runTool } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  try {
    const { tool, args = {}, chapter } = await req.json().catch(() => ({}));
    if (!tool) return NextResponse.json({ error: '缺少 tool' }, { status: 400 });
    const jobId = 'http-' + Date.now();
    const ctx = createToolRuntime({
      projectId: id,
      jobId,
      onProgress: (p) => broadcast({ projectId: id, jobId, ...p }),
      isAborted: () => false,
      chapter: chapter || '',
    });
    const result = await runTool(ctx, tool, args);
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
