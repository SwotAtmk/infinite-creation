// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Shots, Chapters, Projects, pickShotFields, withWriteContext } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

// 整章分镜批量写入：一次调用写完一章的分镜，共享一个 batch_id —— 写坏了可以整批回滚，
// 不必逐条撤。默认 replace=true（先清空该章旧分镜再写入），与「重写这一章」的语义一致。
export async function PUT(req, { params }) {
  const { id, cid } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const chapter = Chapters.get(cid);
  if (!chapter || chapter.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const list = Array.isArray(body?.shots) ? body.shots : null;
  if (!list) return NextResponse.json({ error: '缺少 shots 数组' }, { status: 400 });
  if (list.length > 500) return NextResponse.json({ error: '单章分镜一次最多写入 500 条' }, { status: 400 });
  const replace = body.replace !== false;

  // 先整体校验再落库：任一条非法就整批拒绝，不留下写了一半的章节
  const picked = [];
  for (let i = 0; i < list.length; i++) {
    const { patch, errors } = pickShotFields(list[i]);
    if (errors.length) return NextResponse.json({ error: 'shots[' + i + ']：' + errors.join('；') }, { status: 400 });
    patch.chapter = chapter.title;
    if (patch.idx == null) patch.idx = i + 1;
    picked.push(patch);
  }

  return withWriteContext('PUT /api/projects/:id/chapters/:cid/storyboard', async () => {
    let removed = 0;
    if (replace) removed = Shots.list(id).filter((s) => s.chapter === chapter.title).length;
    if (replace) {
      for (const s of Shots.list(id)) if (s.chapter === chapter.title) Shots.remove(s.id);
    }
    const created = picked.map((p) => Shots.create(id, p));
    return NextResponse.json({ ok: true, replaced: replace, removed, count: created.length, shots: created });
  });
}
