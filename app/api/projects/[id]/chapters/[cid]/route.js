// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, Shots, withWriteContext } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function PATCH(req, { params }) {
  const { id, cid } = await params;
  const body = await req.json().catch(() => ({}));
  const before = Chapters.get(cid);
  // cid 来自 URL 且会被解码（vercel/next.js#64952）。不校验归属就能借别的 projectId 改他项目的
  // 章节标题/正文——与 chapters/[cid]/regenerate 的写法保持一致：先确认章节属于本项目。
  if (!before || before.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  return withWriteContext('PATCH /api/projects/:id/chapters/:cid', async () => {
    const c = Chapters.update(cid, body || {});
    if (!c) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
    if (body?.title && before.title !== c.title) {
      for (const s of Shots.list(id)) if (s.chapter === before.title) Shots.update(s.id, { chapter: c.title });
    }
    return NextResponse.json(c);
  });
}

export async function DELETE(_req, { params }) {
  const { id, cid } = await params;
  // 同上：必须先确认章节属于本项目。Chapters.remove 会级联删除该章分镜
  // （DELETE FROM shots WHERE project_id=<章节自身的 project_id> AND chapter=<标题>），
  // 不校验归属等于「凭任意 cid 删掉他项目的一整章分镜」。
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  return withWriteContext('DELETE /api/projects/:id/chapters/:cid', async () => {
    Chapters.remove(cid);
    return NextResponse.json({ ok: true });
  });
}
