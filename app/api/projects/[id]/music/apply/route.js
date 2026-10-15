// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { startMusicApplyJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { music_id, chapters } = body || {};
  if (!music_id || !Array.isArray(chapters) || !chapters.length) return NextResponse.json({ error: '缺少 music_id 或 chapters' }, { status: 400 });
  const job = startMusicApplyJob({ projectId: id, chapters, musicId: music_id, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
