// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets, withWriteContext } from '@/lib/core/index.js';

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

// 允许经 HTTP 手工编辑的字段白名单。清单里绝不能出现路径类字段
// （image_path / audio_path / video_path / voice_ref）与内部状态字段
// （source / status / parent_id / versions / consistency_key）：
// 路径字段是「可写的磁盘句柄」——客户端若能把 asset.image_path 改成 '..\..\x'，
// 它就会在 references 删除时被 unlinkSync、在提交参考图时被 uploadToInput 上传到
// ComfyUI。路径只允许内部流程（references 上传、生成任务）写入。
const EDITABLE_FIELDS = ['name', 'description', 'category', 'prompt', 'negative_prompt', 'voice_desc'];

export async function PATCH(req, { params }) {
  const { id, aid } = await params;
  const a = Assets.get(aid);
  // 必须先确认素材属于本项目：否则可用别的 projectId 借道改他项目的素材/提示词
  if (!a || a.project_id !== id) return NextResponse.json({ error: '素材不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const patch = {};
  for (const k of EDITABLE_FIELDS) if (body[k] !== undefined) patch[k] = body[k];
  // 这是「用户在素材库里手动改」的唯一入口：保存的提示词要加锁（prompt_locked），
  // 让 LLM 阶段的 update_asset 不得覆盖它——用户改的提示词必须真的生效。
  // 清空提示词（保存空串）等于解锁：之后允许 LLM 重新写。
  if (patch.prompt !== undefined) patch.prompt_locked = String(patch.prompt).trim() ? 1 : 0;
  return withWriteContext('PATCH /api/projects/:id/assets/:aid', async () => NextResponse.json(Assets.update(aid, patch)));
}

export async function DELETE(_req, { params }) {
  const { id, aid } = await params;
  const a = Assets.get(aid);
  if (!a || a.project_id !== id) return NextResponse.json({ error: '素材不存在' }, { status: 404 });
  return withWriteContext('DELETE /api/projects/:id/assets/:aid', async () => {
    Assets.remove(aid);
    return NextResponse.json({ ok: true });
  });
}
