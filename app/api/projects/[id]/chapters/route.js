// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { Chapters, Shots, Projects, extractFrame, resolveProjectPath } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

// 懒生成章节首帧预览图（存在即复用）：从章节第一个已完成分镜的视频抽首帧存为 jpg
// 同一章节的抽取只允许一个在跑：GET /chapters 会被前端高频轮询（WS 每条进度都刷新 + 运行期每 2.5s 一次），
// 少了这道闸门，同一张 posters/<章节id>.jpg 会被多个请求并发抽取/写入，既同时起一堆 ffmpeg，
// 又可能写出半截文件——而「存在即复用」会让这张坏图被永久缓存下来。
const posterInflight = new Set();
async function ensurePoster(projectId, chapterId, firstDoneShot) {
  const rel = 'posters/' + chapterId + '.jpg';
  const abs = resolveProjectPath(projectId, rel);
  if (!abs) return '';
  if (fs.existsSync(abs)) return rel;
  if (posterInflight.has(abs)) return '';
  posterInflight.add(abs);
  try {
    const videoAbs = resolveProjectPath(projectId, firstDoneShot.video_path);
    if (!videoAbs || !fs.existsSync(videoAbs)) return '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await extractFrame(videoAbs, abs);
    return fs.existsSync(abs) ? rel : '';
  } catch { return ''; } finally { posterInflight.delete(abs); }
}

export async function GET(_req, { params }) {
  const { id } = await params;
  const chs = Chapters.list(id);
  const all = Shots.list(id);
  const out = [];
  for (const c of chs) {
    const shots = all.filter((s) => s.chapter === c.title);
    const done = shots.filter((s) => s.status === 'done').length;
    let gen = 'empty';
    if (shots.length) { if (done === shots.length) gen = 'done'; else if (shots.some((s) => s.status === 'running')) gen = 'running'; else if (shots.some((s) => s.status === 'failed')) gen = 'failed'; else gen = 'pending'; }
    const firstDone = shots.find((s) => s.status === 'done' && s.video_path);
    const poster = firstDone ? await ensurePoster(id, c.id, firstDone) : '';
    out.push({ ...c, shotCount: shots.length, doneCount: done, genStatus: gen, poster });
  }
  return NextResponse.json(out);
}

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  // id 未校验就 create，会留下挂在不存在项目下的孤儿章节行（DB 垃圾）；与 /run、/stages 一致先确认项目存在
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const c = Chapters.create(id, body || {});
  return NextResponse.json(c);
}

// 拖拽排序：按传入 id 顺序重排章节 seq（seq 从 1 起，与 create 的 maxSeq+1 一致）
export async function PATCH(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return NextResponse.json({ error: '缺少 ids' }, { status: 400 });
  const valid = new Set(Chapters.list(id).map((c) => c.id));
  if (ids.some((cid) => !valid.has(cid))) return NextResponse.json({ error: '章节不存在' }, { status: 400 });
  ids.forEach((cid, i) => Chapters.update(cid, { seq: i + 1 }));
  return NextResponse.json({ ok: true });
}
