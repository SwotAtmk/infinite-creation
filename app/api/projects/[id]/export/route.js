// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { Shots, Projects, Chapters, resolveProjectPath, slugify, uid, mergeVideos } from '@/lib/core/index.js';
import { runInlineJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const url = new URL(req.url);
    const chapter = body?.chapter || url.searchParams.get('chapter') || '';
    // 顺序：先章节 seq 再章内 idx（多章合并按全局 idx 会交叉成「第1章第1镜、第2章第1镜…」）
    let done = Shots.listInNarrativeOrder(id).filter((s) => s.video_path && s.status === 'done');
    if (chapter) done = done.filter((s) => s.chapter === chapter);
    if (!done.length) return NextResponse.json({ error: chapter ? ('章节「' + chapter + '」没有已完成的镜头') : '没有已完成的分镜' }, { status: 400 });
    const inputs = done.map((s) => resolveProjectPath(id, s.video_path)).filter(Boolean);
    const p = Projects.get(id);
    const base = chapter ? slugify(p.name) + '_' + slugify(chapter) : slugify(p.name);
    const outRel = 'exports/' + base + '_' + uid().slice(0, 8) + '.mp4';
    // 背景音乐：仅按章导出时，把该章已生成的 BGM 垫底混入
    let music;
    if (chapter) {
      const ch = Chapters.list(id).find((c) => c.title === chapter || c.id === chapter);
      const musicAbs = ch?.music_path ? resolveProjectPath(id, ch.music_path) : null;
      if (musicAbs && fs.existsSync(musicAbs)) music = { path: musicAbs, volume: 0.25 };
    }
    // 记成一条任务，使其出现在任务列表（ffmpeg 拼接可能耗时数十秒）
    await runInlineJob(
      { projectId: id, type: 'export', checkpoint: { subject: chapter || '' }, onProgress: (p) => broadcast(p) },
      () => mergeVideos(inputs, resolveProjectPath(id, outRel), { music }),
    );
    return NextResponse.json({ export_path: outRel, url: '/files/projects/' + id + '/' + outRel, shots: done.length, chapter, music: !!music });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
