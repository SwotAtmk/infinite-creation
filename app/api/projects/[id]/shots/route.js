// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Shots, ShotVideos, Chapters, Projects, pickShotFields, idxTakenBy, validateShotContent, withWriteContext } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  // 附带每个分镜的多候选视频列表（单选裁剪候选），前端据此渲染候选选择器
  return NextResponse.json(Shots.list(id).map((s) => ({ ...s, videos: ShotVideos.listByShot(s.id) })));
}

// 创建分镜（外部写入 API / 人工补镜）。只接受内容字段，见 lib/core/shot-write.js。
export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const { patch, errors } = pickShotFields(body);
  if (errors.length) return NextResponse.json({ error: errors.join('；') }, { status: 400 });

  // 分镜按「章节标题」归属（shots.chapter 存标题，与 Chapters.remove 的级联口径一致）。
  // 省略 chapter（或传空串＝未指定）时落到第一章；指定了不存在的章节直接报错，避免写出看不见的孤儿分镜。
  // 先定归属再校验内容：validateShotContent 用「即将落库的值」，否则空 chapter 会被当成非法值。
  const chapters = Chapters.list(id);
  if (!chapters.length) return NextResponse.json({ error: '项目没有章节，请先创建章节' }, { status: 400 });
  const chapter = patch.chapter || chapters[0].title;
  if (!chapters.some((c) => c.title === chapter)) {
    return NextResponse.json({ error: '章节不存在：' + chapter }, { status: 400 });
  }
  patch.chapter = chapter;

  // 新建：按「即将落库的值」做跨字段校验（台词速度 / 说话人数），默认时长与 Shots.create 一致
  const contentErrors = validateShotContent(patch, {});
  if (contentErrors.length) return NextResponse.json({ error: contentErrors.join('；') }, { status: 400 });

  // idx 是章内唯一键：显式给 idx 时也不能与本章已有分镜撞号（撞号会让成片顺序不确定）
  if (patch.idx !== undefined) {
    const dup = idxTakenBy(Shots.list(id), chapter, patch.idx);
    if (dup) return NextResponse.json({ error: 'idx ' + patch.idx + ' 已被本章分镜占用——同一章内镜号必须唯一；省略 idx 可自动接在章内最大镜号之后' }, { status: 400 });
  }

  return withWriteContext('POST /api/projects/:id/shots', async () => {
    const s = Shots.create(id, patch);
    return NextResponse.json(s);
  });
}
