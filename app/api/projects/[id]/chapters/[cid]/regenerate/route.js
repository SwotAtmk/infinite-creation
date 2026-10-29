// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, Shots, withWriteContext } from '@/lib/core/index.js';
import { startCreateJob, startChapterVideoJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

// 本章重新生成（提交即入全局队列、立即开跑，逐个执行）：
// - videos（默认）：generate_chapter_videos force=true 覆盖本章全部视频，不预先清空分镜/视频；
//   排队中被取消不动数据，执行中取消单镜也会恢复为 done —— 不毁掉已完成结果。
// - full：重新拆分分镜（清空本章分镜）。清空动作延迟到任务真正拿到槽位、开始执行前才做：
//   排队中被取消则一行数据都不动。
//   full 只跑 LLM 文本（renderDisabled=true）：重新拆分镜、写提示词，不提交 ComfyUI、不出图/视频；
//   要出视频请用 mode=videos（或「生成/继续」整条流水线）。
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
  const beforeRun = () => withWriteContext('job:regenerate-chapter-full', () => {
    // 清空本章分镜 + 复位章节状态是两次写入：包一个写上下文，日志才不会退化成
    // source='internal'、batch_id=''（那种日志无法按批定位 / 整批回滚）。
    for (const s of shots) Shots.remove(s.id);
    Chapters.update(ch.id, { status: 'pending' });
  });
  const job = (() => {
    try {
      return startCreateJob({ projectId: id, chapter: ch.title, onProgress: (patch) => broadcast(patch), beforeRun, renderDisabled: true });
    } catch (e) {
      // 项目关闭自动生成剧本且本章剧本为空：重新拆分镜会被前置检查拦下，翻成 400 而不是 500
      if (e && e.code === 'SCRIPT_REQUIRED') return null;
      throw e;
    }
  })();
  if (!job) return NextResponse.json({ error: '本章还没有剧本，且项目未开启自动生成剧本；请先在章节「剧本」里编写/粘贴，或在项目设置中开启自动生成。' }, { status: 400 });
  return NextResponse.json({ reset: shots.length, chapter: ch.title, mode, job });
}
