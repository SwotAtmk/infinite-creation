// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function PATCH(req, { params }) {
  const { aid } = await params;
  const body = await req.json().catch(() => ({}));
  const patch = { ...(body || {}) };
  // 这是「用户在素材库里手动改」的唯一入口：保存的提示词要加锁（prompt_locked），
  // 让 LLM 阶段的 update_asset 不得覆盖它——用户改的提示词必须真的生效。
  // 清空提示词（保存空串）等于解锁：之后允许 LLM 重新写。
  if (patch.prompt !== undefined) patch.prompt_locked = String(patch.prompt).trim() ? 1 : 0;
  return NextResponse.json(Assets.update(aid, patch));
}

export async function DELETE(_req, { params }) {
  const { aid } = await params;
  Assets.remove(aid);
  return NextResponse.json({ ok: true });
}
