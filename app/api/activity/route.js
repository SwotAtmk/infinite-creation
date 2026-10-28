// 全局活动：当前有哪些项目/章节任务在跑、每个任务当前真正执行到哪个渲染子任务。
// 开源版本地单用户部署，直接返回全部项目。
import { NextResponse } from 'next/server';
import { Jobs, Projects, Queue } from '@/lib/core/index.js';
import { agentGateSnapshot } from '@/lib/agent/agent-gate.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const allowed = new Map(Projects.list().map((p) => [p.id, p]));
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
    jobs,
    queue: { running: running.length, waiting: waiting.length },
    agent: agentGateSnapshot(),
    updatedAt: Date.now(),
  });
}
