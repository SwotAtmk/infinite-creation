// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Chapters, Shots, Projects, ensureChapterPoster, withWriteContext, chapterStats, pickChapterFields, projectDir, slugify } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  const chs = Chapters.list(id);
  const all = Shots.list(id);
  // 成片目录里的导出视频：按章节标题匹配（文件名形如「项目名_章节名_uid.mp4」），取最新一条，
  // 供「完成」章节点击预览图直接播放最新成片。「不带字幕」副本只作下载配套，不作为播放对象。
  const proj = Projects.get(id);
  const exportsDir = path.join(projectDir(id), 'exports');
  let exportVideos = [];
  try {
    exportVideos = fs.readdirSync(exportsDir)
      .filter((f) => /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(f) && !/_nosub\.[^.]+$/i.test(f))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(exportsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {}
  const latestVideo = (title) => {
    const prefix = slugify(proj?.name || '') + '_' + slugify(title) + '_';
    const hit = exportVideos.find((f) => f.name.startsWith(prefix));
    return hit ? '/files/projects/' + id + '/exports/' + hit.name : '';
  };
  const out = [];
  for (const c of chs) {
    const shots = all.filter((s) => s.chapter === c.title);
    const firstDone = shots.find((s) => s.status === 'done' && s.video_path);
    const poster = firstDone ? await ensureChapterPoster(id, c.id, firstDone) : '';
    // 进度摘要走 lib/core 的唯一实现：分镜的「生成中」状态是 generating，不是 running
    // （早先这里内联判 running，永远不命中 → 正在出视频的章节被显示成「待生成」）
    const st = chapterStats(id, c.title);
    out.push({ ...c, shotCount: st.total, doneCount: st.done, genStatus: st.status, poster, video: latestVideo(c.title) });
  }
  return NextResponse.json(out);
}

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  // id 未校验就 create，会留下挂在不存在项目下的孤儿章节行（DB 垃圾）；与 /run、/stages 一致先确认项目存在
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  // 与 PATCH …/chapters/:cid 同口径：只认内容字段。此前请求体整包丢给 Chapters.create，
  // 拼错的字段（titel/noval）被静默忽略却回 200「创建成功」，调用方以为写进去了。
  const { patch, errors } = pickChapterFields(body);
  if (errors.length) return NextResponse.json({ error: errors.join('；') }, { status: 400 });
  return withWriteContext('POST /api/projects/:id/chapters', async () => {
    try {
      const c = Chapters.create(id, patch);
      return NextResponse.json(c);
    } catch (e) {
      // 同项目标题唯一（章节是分镜的归属键，重名会让两章共用分镜）：底层抛错，这里翻成 400
      if (e && e.code === 'DUP_CHAPTER_TITLE') return NextResponse.json({ error: e.message }, { status: 400 });
      throw e;
    }
  });
}

// 拖拽排序：按传入 id 顺序重排章节 seq（领域校验在 lib/core 的 Chapters.reorder 里，
// 这里只负责把 BAD_CHAPTER_ORDER 翻成 400）
export async function PATCH(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids : [];
  // 一次排序 = 一个批次：整批回滚即可还原排序前的 seq
  return withWriteContext('PATCH /api/projects/:id/chapters', async () => {
    try {
      return NextResponse.json(Chapters.reorder(id, ids));
    } catch (e) {
      if (e && e.code === 'BAD_CHAPTER_ORDER') return NextResponse.json({ error: e.message }, { status: 400 });
      throw e;
    }
  });
}
