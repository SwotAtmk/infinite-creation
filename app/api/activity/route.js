// 全局活动：当前有哪些项目/章节任务在跑、每个任务当前真正执行到哪个渲染子任务。
// 普通用户只看自己的项目；管理员（含免登录本机）看全部。
import { NextResponse } from 'next/server';
import { Jobs, Projects, Queue } from '@/lib/core/index.js';
import { agentGateSnapshot } from '@/lib/agent/agent-gate.js';
import { authenticateRequest, authEnabled } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const user = authenticateRequest(req, new URL(req.url));
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const isAdmin = !authEnabled() || user.role === 'admin';
  const allowed = new Map();
  for (const p of Projects.list()) {
    if (isAdmin || p.owner_id === user.id) allowed.set(p.id, p);
  }
  const active = Jobs.list().filter(
    (j) => (j.status === 'running' || j.status === 'queued') && allowed.has(j.projectId),
  );
  const running = Queue.running().filter((q) => allowed.has(q.projectId));
  const waiting = Queue.waiting().filter((q) => allowed.has(q.projectId));
  const rank = (q) => (q.status === 'running' ? -1 : 0);
  const byJob = new Map();
  for (const q of [...running, ...waiting]) {
    if (!q.jobId) continue;
    const prev = byJob.get(q.jobId);
    if (!prev || rank(q) < rank(prev)) byJob.set(q.jobId, q);
  }
  const jobs = active
    .map((j) => {
      const p = allowed.get(j.projectId);
      const q = byJob.get(j.id) || null;
      return {
        id: j.id,
        projectId: j.projectId,
        projectName: p?.name || '',
        type: j.type,
        status: j.status,
        phase: j.phase || '',
        detail: j.detail || '',
        chapter: j.checkpoint?.chapter || '',
        checkpoint: j.checkpoint || {},
        startedAt: j.startedAt || 0,
        queue: q
          ? {
              id: q.id, status: q.status, kind: q.kind, pool: q.pool,
              chapter: q.payload?.chapter || '', subject: q.payload?.subject || '',
            }
          : null,
      };
    })
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  return NextResponse.json({
    isAdmin,
    jobs,
    queue: { running: running.length, waiting: waiting.length },
    agent: agentGateSnapshot(),
    updatedAt: Date.now(),
  });
}
