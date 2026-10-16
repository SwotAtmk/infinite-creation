// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { ReferenceImages, Assets, resolveProjectPath, withWriteContext } from '@/lib/core/index.js';
import { ASSET_CATEGORY_IDS } from '@/lib/shared/index.js';

export const dynamic = 'force-dynamic';

export async function DELETE(_req, { params }) {
  const { id, rid } = await params;
  const ref = ReferenceImages.get(rid);
  if (!ref || ref.project_id !== id) return NextResponse.json({ error: '参考素材不存在' }, { status: 404 });
  return withWriteContext('DELETE /api/projects/:id/references/:rid', async () => {
    // 注意：图片文件是真删（unlink），回滚只能复原 DB 行、找不回文件；这是有意为之，
    // 避免回滚误删/误存用户素材。要恢复图片请重新上传。
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
  });
}

// 编辑参考素材：mode / category / description（不移动原图文件，复用同一份图）
export async function PATCH(req, { params }) {
  const { id, rid } = await params;
  const body = await req.json().catch(() => null) || {};
  const ref = ReferenceImages.get(rid);
  if (!ref || ref.project_id !== id) return NextResponse.json({ error: '参考素材不存在' }, { status: 404 });

  const mode = body.mode === 'library' ? 'library' : body.mode === 'reference' ? 'reference' : ref.mode;
  const category = body.category !== undefined ? String(body.category || 'other') : ref.category;
  // 分类值域（素材库按 category 过滤；切到素材库时会用它建资产）
  if (!ASSET_CATEGORY_IDS.includes(category)) return NextResponse.json({ error: '素材分类不存在：' + category }, { status: 400 });
  const description = body.description !== undefined ? String(body.description || '') : ref.description;

  return withWriteContext('PATCH /api/projects/:id/references/:rid', async () => {
    // 参考 -> 素材库：新建关联资产，复用原图文件
    if (mode === 'library' && ref.mode !== 'library') {
      const asset = Assets.create(id, { category, name: ref.name, description });
      Assets.update(asset.id, { image_path: ref.image_path, source: 'uploaded', status: 'done' });
      ReferenceImages.update(rid, { mode, category, description, asset_id: asset.id });
      return NextResponse.json({ reference: ReferenceImages.get(rid), asset });
    }
    // 素材库 -> 参考：移除关联资产（保留原图文件供参考图继续使用）
    if (mode === 'reference' && ref.mode === 'library') {
      if (ref.asset_id) {
        // 先问「这条素材还在被用吗」：删掉它等于把子变体（服装/年龄）一并删掉，
        // 分镜上的引用会静默失效（参考图少一张、提示词里的 __MINIMAX_H3_REF_N__ 编号错位）。
        // 与其静默损失，不如让用户先处理掉引用或保留在素材库。
        const use = Assets.usageOf(ref.asset_id);
        const why = [];
        if (use.children) why.push('有 ' + use.children + ' 个变体素材（服装/年龄）会一起被删');
        if (use.shotIds.length) why.push('正被 ' + use.shotIds.length + ' 个分镜引用，删除后这些引用会失效');
        if (why.length) {
          return NextResponse.json({ error: '该素材仍在使用中：' + why.join('；') + '。请先删除变体/解除分镜引用，或保留「素材库」用途。' }, { status: 400 });
        }
        Assets.remove(ref.asset_id);
      }
      ReferenceImages.update(rid, { mode, category, description, asset_id: '' });
      return NextResponse.json({ reference: ReferenceImages.get(rid) });
    }
    // 同模式：更新字段；library 模式下同步关联资产
    ReferenceImages.update(rid, { mode, category, description });
    if (mode === 'library' && ref.asset_id) {
      Assets.update(ref.asset_id, { category, description });
    }
    return NextResponse.json({ reference: ReferenceImages.get(rid) });
  });
}
