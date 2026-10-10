// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, Shots } from '@/lib/core/index.js';
import { startCreateJob, startChapterVideoJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

// 本章重新生成（提交即入全局队列、立即开跑，逐个执行）：
// - videos（默认）：generate_chapter_videos force=true 覆盖本章全部视频，不预先清空分镜/视频；
//   排队中被取消不动数据，执行中取消单镜也会恢复为 done —— 不毁掉已完成结果。
// - full：重新拆分分镜（清空本章分镜）。清空动作延迟到任务真正拿到槽位、开始执行前才做：
//   排队中被取消则一行数据都不动。
export async function POST(req, { params }) {
  const { id, cid } = await params;
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') === 'full' ? 'full' : 'videos';
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  const shots = Shots.list(id).filter((s) => s.chapter === ch.title);
  if (mode === 'videos') {
    const job = startChapterVideoJob({ projectId: id, chapter: ch.title, onProgress: (patch) => broadcast(patch) });
    return NextResponse.json({ reset: 0, chapter: ch.title, mode, job });
  }
  const beforeRun = () => {
    for (const s of shots) Shots.remove(s.id);
    Chapters.update(ch.id, { status: 'pending' });
  };
  const job = startCreateJob({ projectId: id, chapter: ch.title, onProgress: (patch) => broadcast(patch), beforeRun });
  return NextResponse.json({ reset: shots.length, chapter: ch.title, mode, job });
}
