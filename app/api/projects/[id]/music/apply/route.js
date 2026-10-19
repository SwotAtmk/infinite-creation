// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { startMusicApplyJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { music_id, chapters } = body || {};
  if (!music_id || !Array.isArray(chapters) || !chapters.length) return NextResponse.json({ error: '缺少 music_id 或 chapters' }, { status: 400 });
  // 与 /music、/chapters 一致：先确认项目存在。否则 createToolRuntime 会在「任务行已建」之后抛错，
  // 既返 500 又留下一条永远 running 的孤儿任务（项目不存在，没人会去结算它）。
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  // 章节按标题/id 字符串匹配，非字符串元素直接丢弃（否则会以 [object Object] 写进任务记录）
  const titles = chapters.filter((t) => typeof t === 'string' && t.trim());
  if (!titles.length) return NextResponse.json({ error: '缺少有效的 chapters' }, { status: 400 });
  const job = startMusicApplyJob({ projectId: id, chapters: titles, musicId: music_id, onProgress: (p) => broadcast(p) });
  return NextResponse.json(job);
}
