// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

// 单个素材详情。素材库「编辑 / 音色」弹窗打开时会 api.get 它拿最新数据——
// 此前本文件只有 PATCH/DELETE，客户端拿到的是 405，弹窗读不到后端刚写入的
// voice_ref/voice_desc（被 .catch 静默吞掉）。这里补上 GET。
export async function GET(_req, { params }) {
  const { id, aid } = await params;
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '素材不存在' }, { status: 404 });
  return NextResponse.json(a);
}

export async function PATCH(req, { params }) {
  const { id, aid } = await params;
  const a = Assets.get(aid);
  // 必须先确认素材属于本项目：否则可用别的 projectId 借道改他项目的素材/提示词
  if (!a || a.project_id !== id) return NextResponse.json({ error: '素材不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const patch = { ...(body || {}) };
  // 这是「用户在素材库里手动改」的唯一入口：保存的提示词要加锁（prompt_locked），
  // 让 LLM 阶段的 update_asset 不得覆盖它——用户改的提示词必须真的生效。
  // 清空提示词（保存空串）等于解锁：之后允许 LLM 重新写。
  if (patch.prompt !== undefined) patch.prompt_locked = String(patch.prompt).trim() ? 1 : 0;
  return NextResponse.json(Assets.update(aid, patch));
}

export async function DELETE(_req, { params }) {
  const { id, aid } = await params;
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '素材不存在' }, { status: 404 });
  Assets.remove(aid);
  return NextResponse.json({ ok: true });
}
