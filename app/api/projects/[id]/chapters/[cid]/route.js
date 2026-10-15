// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, Shots, withWriteContext, tx } from '@/lib/core/index.js';
import { activeJobOf } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

export async function PATCH(req, { params }) {
  const { id, cid } = await params;
  const body = await req.json().catch(() => ({}));
  const before = Chapters.get(cid);
  // cid 来自 URL 且会被解码（vercel/next.js#64952）。不校验归属就能借别的 projectId 改他项目的
  // 章节标题/正文——与 chapters/[cid]/regenerate 的写法保持一致：先确认章节属于本项目。
  if (!before || before.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  return withWriteContext('PATCH /api/projects/:id/chapters/:cid', async () => {
    try {
      // 改标题要连带迁移该章分镜的 chapter 字段（shots 按标题归属）：包一个事务，
      // 避免「标题改了、部分分镜还挂在旧标题下」这种半迁移状态。
      const c = tx(() => {
        const updated = Chapters.update(cid, body || {});
        if (!updated) return null;
        if (body?.title && before.title !== updated.title) {
          for (const s of Shots.list(id)) if (s.chapter === before.title) Shots.update(s.id, { chapter: updated.title });
        }
        return updated;
      });
      if (!c) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
      return NextResponse.json(c);
    } catch (e) {
      if (e && e.code === 'DUP_CHAPTER_TITLE') return NextResponse.json({ error: e.message }, { status: 400 });
      throw e;
    }
  });
}

export async function DELETE(_req, { params }) {
  const { id, cid } = await params;
  // 同上：必须先确认章节属于本项目。Chapters.remove 会级联删除该章分镜
  // （DELETE FROM shots WHERE project_id=<章节自身的 project_id> AND chapter=<标题>），
  // 不校验归属等于「凭任意 cid 删掉他项目的一整章分镜」。
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  // 级联删该章分镜：运行中的任务正持有这些行，删掉后它的回写只会静默落空
  if (activeJobOf(id)) return NextResponse.json({ error: '项目正在运行任务，运行中不可删除章节；请等任务结束或先停止任务' }, { status: 409 });
  return withWriteContext('DELETE /api/projects/:id/chapters/:cid', async () => {
    Chapters.remove(cid);
    return NextResponse.json({ ok: true });
  });
}
