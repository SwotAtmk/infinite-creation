// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, projectDir } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  return NextResponse.json(Jobs.list(id));
}

// 清除已结束任务（完成/失败/已取消/已中断）：只删记录与日志，不动活动任务、不动素材/成片。
export async function DELETE(_req, { params }) {
  const { id } = await params;
  const finished = Jobs.list(id).filter((j) => j.status !== 'running' && j.status !== 'queued');
  for (const j of finished) {
    try { fs.unlinkSync(path.join(projectDir(id), 'logs', j.id + '.log')); } catch {}
    if (j.logPath) { try { fs.unlinkSync(j.logPath); } catch {} }
    Jobs.remove(j.id);
  }
  return NextResponse.json({ removed: finished.length });
}
