// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, Shots, Projects } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  const chs = Chapters.list(id);
  const all = Shots.list(id);
  return NextResponse.json(chs.map((c) => {
    const shots = all.filter((s) => s.chapter === c.title);
    const done = shots.filter((s) => s.status === 'done').length;
    let gen = 'empty';
    if (shots.length) { if (done === shots.length) gen = 'done'; else if (shots.some((s) => s.status === 'running')) gen = 'running'; else if (shots.some((s) => s.status === 'failed')) gen = 'failed'; else gen = 'pending'; }
    return { ...c, shotCount: shots.length, doneCount: done, genStatus: gen };
  }));
}

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  // id 未校验就 create，会留下挂在不存在项目下的孤儿章节行（DB 垃圾）；与 /run、/stages 一致先确认项目存在
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const c = Chapters.create(id, body || {});
  return NextResponse.json(c);
}
