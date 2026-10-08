// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { ReferenceImages, Assets, resolveProjectPath } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function DELETE(_req, { params }) {
  const { id, rid } = await params;
  const ref = ReferenceImages.get(rid);
  if (!ref || ref.project_id !== id) return NextResponse.json({ error: '参考素材不存在' }, { status: 404 });
  if (ref.image_path) {
    try { fs.unlinkSync(resolveProjectPath(id, ref.image_path)); } catch {}
  }
  if (ref.asset_id) {
    const asset = Assets.get(ref.asset_id);
    if (asset) {
      if (asset.image_path) {
        try { fs.unlinkSync(resolveProjectPath(id, asset.image_path)); } catch {}
      }
      Assets.remove(asset.id);
    }
  }
  ReferenceImages.remove(rid);
  return NextResponse.json({ ok: true });
}

// 编辑参考素材：mode / category / description（不移动原图文件，复用同一份图）
export async function PATCH(req, { params }) {
  const { id, rid } = await params;
  const body = await req.json().catch(() => null) || {};
  const ref = ReferenceImages.get(rid);
  if (!ref || ref.project_id !== id) return NextResponse.json({ error: '参考素材不存在' }, { status: 404 });

  const mode = body.mode === 'library' ? 'library' : body.mode === 'reference' ? 'reference' : ref.mode;
  const category = body.category !== undefined ? String(body.category || 'other') : ref.category;
  const description = body.description !== undefined ? String(body.description || '') : ref.description;

  // 参考 -> 素材库：新建关联资产，复用原图文件
  if (mode === 'library' && ref.mode !== 'library') {
    const asset = Assets.create(id, { category, name: ref.name, description });
    Assets.update(asset.id, { image_path: ref.image_path, source: 'uploaded', status: 'done' });
    ReferenceImages.update(rid, { mode, category, description, asset_id: asset.id });
    return NextResponse.json({ reference: ReferenceImages.get(rid), asset });
  }
  // 素材库 -> 参考：移除关联资产（保留原图文件供参考图继续使用）
  if (mode === 'reference' && ref.mode === 'library') {
    if (ref.asset_id) Assets.remove(ref.asset_id);
    ReferenceImages.update(rid, { mode, category, description, asset_id: '' });
    return NextResponse.json({ reference: ReferenceImages.get(rid) });
  }
  // 同模式：更新字段；library 模式下同步关联资产
  ReferenceImages.update(rid, { mode, category, description });
  if (mode === 'library' && ref.asset_id) {
    Assets.update(ref.asset_id, { category, description });
  }
  return NextResponse.json({ reference: ReferenceImages.get(rid) });
}
