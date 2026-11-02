// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 无限・秩影单条记录：PATCH 编辑 / DELETE 删除（带 opuscar 任务运行中守卫）。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, Assets, Jobs, SKILLS_DIR, uid, slugify, resolveProjectPath, withWriteContext } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

function loadCatalog() {
  const file = path.join(SKILLS_DIR, 'lemo-opuscar', 'styleboard', 'catalog.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function activeOpuscarJob(projectId, assetId) {
  return Jobs.list(projectId).find(
    (j) => j.type === 'opuscar' && (j.status === 'running' || j.status === 'queued') && (j.checkpoint || {}).subject === assetId,
  );
}

// 编辑时重排素材：每条记录独立工作区 film/<assetId>/materials/。
// 已在该工作区里的直接保留，uploads/ 或旧 film/materials/ 的复制进本记录工作区。
function restage(projectId, assetId, references) {
  const prefix = 'film/' + assetId + '/materials/';
  const stored = [];
  for (const r of references || []) {
    const rel = String(r.filename || r.path || '').trim();
    if (!rel) continue;
    const type = ['image', 'audio', 'video', 'file'].includes(r.type) ? r.type : 'file';
    if (rel.startsWith(prefix)) {
      stored.push({ type, filename: rel, name: r.name || '' });
      continue;
    }
    const srcAbs = resolveProjectPath(projectId, rel);
    if (!srcAbs || !fs.existsSync(srcAbs)) throw new Error('素材不存在：' + rel);
    const ext = path.extname(rel);
    const base = path.basename(rel, ext) || 'mat';
    const destRel = prefix + slugify(base) + '_' + uid().slice(0, 6) + ext;
    const destAbs = resolveProjectPath(projectId, destRel);
    if (!destAbs) throw new Error('素材路径非法');
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
    stored.push({ type, filename: destRel, name: r.name || path.basename(rel) });
  }
  return stored;
}

export async function PATCH(req, { params }) {
  const { id, aid } = await params;
  const a = Assets.get(aid);
  if (!a || a.project_id !== id || a.category !== 'video') return NextResponse.json({ error: '记录不存在' }, { status: 404 });
  const active = activeOpuscarJob(id, aid);
  if (active) {
    return NextResponse.json({ error: '该记录正在生成中，暂时不能编辑', code: 'ALREADY_RENDERING', jobId: active.id }, { status: 409 });
  }
  const body = await req.json().catch(() => ({}));
  const patch = {};
  if (body.name !== undefined) patch.name = String(body.name || '');
  if (body.prompt !== undefined) patch.prompt = String(body.prompt || '');

  if (body.style_slug !== undefined || body.references !== undefined || body.custom_style !== undefined) {
    const old = a.params || {};
    const style_slug = body.style_slug !== undefined ? String(body.style_slug) : (old.style_slug || '');
    const isCustom = style_slug === '__custom__';
    const customStyle = isCustom
      ? String(body.custom_style !== undefined ? body.custom_style : (old.custom_style || '')).trim()
      : '';
    if (isCustom && !customStyle) return NextResponse.json({ error: '缺少自定义风格描述 custom_style' }, { status: 400 });
    let style = null;
    if (!isCustom && style_slug) {
      const catalog = loadCatalog();
      style = catalog.find((s) => s.slug === style_slug);
      if (!style) return NextResponse.json({ error: '风格不存在：' + style_slug }, { status: 400 });
    }
    let references = body.references !== undefined ? body.references : (old.references || []);
    let storedRefs;
    try {
      storedRefs = restage(id, aid, references);
    } catch (e) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    // 编辑只改风格/素材，保留已有的对话历史（chat）不被覆盖。
    const chat = Array.isArray(old.chat) ? old.chat : [];
    patch.params = isCustom
      ? { style_slug: '__custom__', style_cn: '自定义风格', style_en: 'Custom', cat: '自定义', custom_style: customStyle, references: storedRefs, chat }
      : { style_slug, style_cn: style ? style.cn : (old.style_cn || ''), style_en: style ? style.en : (old.style_en || ''), cat: style ? style.cat : (old.cat || ''), references: storedRefs, chat };
  }

  if (!Object.keys(patch).length) return NextResponse.json({ error: '无更新字段' }, { status: 400 });
  return withWriteContext('PATCH /api/projects/:id/opuscar/:aid', async () => NextResponse.json(Assets.update(aid, patch)));
}

export async function DELETE(_req, { params }) {
  const { id, aid } = await params;
  const a = Assets.get(aid);
  if (!a || a.project_id !== id || a.category !== 'video') return NextResponse.json({ error: '记录不存在' }, { status: 404 });
  const active = activeOpuscarJob(id, aid);
  if (active) {
    return NextResponse.json({ error: '该记录正在生成中，暂时不能删除', code: 'ALREADY_RENDERING', jobId: active.id }, { status: 409 });
  }
  return withWriteContext('DELETE /api/projects/:id/opuscar/:aid', async () => {
    Assets.remove(aid);
    return NextResponse.json({ ok: true });
  });
}
