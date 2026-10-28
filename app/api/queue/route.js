// 渲染队列观测接口：开源版没有账号/管理员概念，队列状态与恢复操作直接开放。
import { NextResponse } from 'next/server';
import { queueSnapshot, resumeQueue } from '@/lib/core/scheduler.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(queueSnapshot({ ownerId: 'local', isAdmin: true }));
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  if (body?.action === 'resume') {
    resumeQueue();
    return NextResponse.json({ ok: true, ...queueSnapshot({}) });
  }
  return NextResponse.json({ error: '未知操作' }, { status: 400 });
}
