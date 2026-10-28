// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Shots, Chapters, Projects, pickShotFields, idxTakenBy, validateShotContent, withWriteContext, tx } from '@/lib/core/index.js';
import { activeJobOfChapter } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// 整章分镜批量写入：一次调用写完一章的分镜，共享一个 batch_id —— 写坏了可以整批回滚，
// 不必逐条撤。默认 replace=true（先清空该章旧分镜再写入），与「重写这一章」的语义一致。
export async function PUT(req, { params }) {
  const { id, cid } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const chapter = Chapters.get(cid);
  if (!chapter || chapter.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  // replace 会删掉该章现有分镜（含已渲染、status=done 的行）：正在运行的任务持有这些行，
  // 删掉后它的回写只会静默落空，最终「成片与当前分镜表不一致」。只挡同一章的任务，
  // 其他章节正在跑时允许重写本章（章节之间互不影响）。
  if (activeJobOfChapter(id, chapter.title)) {
    return NextResponse.json({ error: '本章正在运行任务，运行中不可整章重写分镜；请等任务结束或先停止任务' }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const list = Array.isArray(body?.shots) ? body.shots : null;
  if (!list) return NextResponse.json({ error: '缺少 shots 数组' }, { status: 400 });
  if (list.length > 500) return NextResponse.json({ error: '单章分镜一次最多写入 500 条' }, { status: 400 });
  const replace = body.replace !== false;

  // replace:false 是「追加」：镜号要从该章现有最大 idx 往后接。否则新镜头从 1 重新编号，
  // 与旧镜头撞号——idx 是章内镜号，撞号会让 assemble_video 的排序结果不确定。
  const existing = replace ? [] : Shots.list(id).filter((s) => s.chapter === chapter.title);
  const base = existing.reduce((m, s) => Math.max(m, Number(s.idx) || 0), 0);

  // 先整体校验再落库：任一条非法就整批拒绝，不留下写了一半的章节
  const picked = [];
  const usedIdx = new Map();
  for (let i = 0; i < list.length; i++) {
    const { patch, errors } = pickShotFields(list[i]);
    if (errors.length) return NextResponse.json({ error: 'shots[' + i + ']：' + errors.join('；') }, { status: 400 });
    // 章节由 URL 决定：body 里带的 chapter 一律覆盖，再校验（避免 body 传空 chapter 被误拒）
    patch.chapter = chapter.title;
    const contentErrors = validateShotContent(patch, {});
    if (contentErrors.length) return NextResponse.json({ error: 'shots[' + i + ']：' + contentErrors.join('；') }, { status: 400 });
    if (patch.idx == null) patch.idx = base + i + 1;
    if (usedIdx.has(patch.idx)) {
      return NextResponse.json({ error: 'shots[' + i + ']：idx ' + patch.idx + ' 与 shots[' + usedIdx.get(patch.idx) + '] 重复——同一章内镜号必须唯一' }, { status: 400 });
    }
    // 追加模式下还要与「库里已有镜头」比：usedIdx 只看本批，跨批撞号会让成片顺序不确定
    if (idxTakenBy(existing, chapter.title, patch.idx)) {
      return NextResponse.json({ error: 'shots[' + i + ']：idx ' + patch.idx + ' 已被本章已有分镜占用——同一章内镜号必须唯一；追加时省略 idx 会自动接在章内最大镜号之后' }, { status: 400 });
    }
    usedIdx.set(patch.idx, i);
    picked.push(patch);
  }

  return withWriteContext('PUT /api/projects/:id/chapters/:cid/storyboard', () =>
    NextResponse.json(tx(() => {
      // 先删后建包在一个事务里：中途失败不留「旧分镜删了、新的没进来」的空章
      let removed = 0;
      if (replace) {
        for (const s of Shots.list(id)) {
          if (s.chapter === chapter.title) { Shots.remove(s.id); removed++; }
        }
      }
      const created = picked.map((p) => Shots.create(id, p));
      return { ok: true, replaced: replace, removed, count: created.length, shots: created };
    })));
}
