// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Shots, Chapters, pickShotFields, validateShotContent, withWriteContext } from '@/lib/core/index.js';
import { activeJobOf } from '@/lib/agent/index.js';

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
  // 跨字段校验用「合并后的有效值」：只改台词不改时长时，上限要按行上已有的时长算
  const contentErrors = validateShotContent(patch, shot);
  if (contentErrors.length) return NextResponse.json({ error: contentErrors.join('；') }, { status: 400 });
  if (patch.chapter) {
    const titles = new Set(Chapters.list(id).map((c) => c.title));
    if (!titles.has(patch.chapter)) return NextResponse.json({ error: '章节不存在：' + patch.chapter }, { status: 400 });
  }

  return withWriteContext('PATCH /api/projects/:id/shots/:sid', async () => NextResponse.json(Shots.update(sid, patch)));
}

export async function DELETE(_req, { params }) {
  const { id, sid } = await params;
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
  // 运行中的任务持有这一行：删掉后它的回写（Shots.update）只会静默落空，
  // 于是「成片用的是旧分镜、分镜表里已经没有这条」。运行中一律拒绝。
  if (activeJobOf(id)) return NextResponse.json({ error: '项目正在运行任务，运行中不可删除分镜；请等任务结束或先停止任务' }, { status: 409 });
  return withWriteContext('DELETE /api/projects/:id/shots/:sid', async () => {
    Shots.remove(sid);
    return NextResponse.json({ ok: true });
  });
}
