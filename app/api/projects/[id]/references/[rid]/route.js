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
