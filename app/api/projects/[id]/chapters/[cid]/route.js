// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, Shots } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function PATCH(req, { params }) {
  const { id, cid } = await params;
  const body = await req.json().catch(() => ({}));
  const before = Chapters.get(cid);
  const c = Chapters.update(cid, body || {});
  if (!c) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  if (before && body?.title && before.title !== c.title) {
    for (const s of Shots.list(id)) if (s.chapter === before.title) Shots.update(s.id, { chapter: c.title });
  }
  return NextResponse.json(c);
}

export async function DELETE(_req, { params }) {
  const { cid } = await params;
  Chapters.remove(cid);
  return NextResponse.json({ ok: true });
}
