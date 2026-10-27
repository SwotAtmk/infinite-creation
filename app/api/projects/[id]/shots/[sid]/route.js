// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Shots, Chapters, pickShotFields, idxTakenBy, validateShotContent, withWriteContext } from '@/lib/core/index.js';
import { activeJobOfChapter } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// 更新分镜。原实现只允许 6 个 *_ids 字段（素材绑定），外部无法写入分镜正文；
// 现改为走 shot-write 白名单：内容字段可写，生成产物字段（status/error/video_path…）仍被拒绝。
export async function PATCH(req, { params }) {
  const { id, sid } = await params;
  const body = await req.json().catch(() => ({}));
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });

  const { patch, errors } = pickShotFields(body);
  if (errors.length) return NextResponse.json({ error: errors.join('；') }, { status: 400 });
  if (!Object.keys(patch).length) return NextResponse.json({ error: '无可更新字段' }, { status: 400 });
  // 跨字段校验（台词速度/说话人数）只在本次改了台词或时长时才做——见 shot-write.js
  // validateShotContent 的说明：拿库里旧值重算会让历史脏行整行不可编辑（绑素材也被 400 挡住）
  const contentErrors = validateShotContent(patch, shot);
  if (contentErrors.length) return NextResponse.json({ error: contentErrors.join('；') }, { status: 400 });
  if (patch.chapter) {
    const titles = new Set(Chapters.list(id).map((c) => c.title));
    if (!titles.has(patch.chapter)) return NextResponse.json({ error: '章节不存在：' + patch.chapter }, { status: 400 });
  }
  // 改 idx（可能连着改所属章）时按「目标章节」判章内唯一：idx 是成片排序键，撞号顺序不确定
  if (patch.idx !== undefined) {
    const dup = idxTakenBy(Shots.list(id), patch.chapter || shot.chapter, patch.idx, sid);
    if (dup) return NextResponse.json({ error: 'idx ' + patch.idx + ' 已被该章分镜占用——同一章内镜号必须唯一' }, { status: 400 });
  }

  return withWriteContext('PATCH /api/projects/:id/shots/:sid', async () => NextResponse.json(Shots.update(sid, patch)));
}

export async function DELETE(_req, { params }) {
  const { id, sid } = await params;
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
  // 运行中的任务持有这一行：删掉后它的回写（Shots.update）只会静默落空，
  // 于是「成片用的是旧分镜、分镜表里已经没有这条」。只挡同一章的任务。
  if (activeJobOfChapter(id, shot.chapter)) {
    return NextResponse.json({ error: '本章正在运行任务，运行中不可删除分镜；请等任务结束或先停止任务' }, { status: 409 });
  }
  return withWriteContext('DELETE /api/projects/:id/shots/:sid', async () => {
    Shots.remove(sid);
    return NextResponse.json({ ok: true });
  });
}
