// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, Shots } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, cid } = await params;
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') === 'full' ? 'full' : 'videos';
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  const shots = Shots.list(id).filter((s) => s.chapter === ch.title);
  let n = 0;
  for (const s of shots) {
    if (mode === 'full') { Shots.remove(s.id); } else { Shots.update(s.id, { status: 'pending', video_path: '', seed: 0, error: '' }); }
    n++;
  }
  Chapters.update(ch.id, { status: 'pending' });
  return NextResponse.json({ reset: n, chapter: ch.title, mode });
}
