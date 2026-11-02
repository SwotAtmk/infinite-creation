// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 无限・秩影记录：GET 列表 / POST 创建（或 asset_id 重新生成）生成任务。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, Assets, SKILLS_DIR, uid, slugify, resolveProjectPath, withWriteContext } from '@/lib/core/index.js';
import { startOpuscarJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

function loadCatalog() {
  const file = path.join(SKILLS_DIR, 'lemo-opuscar', 'styleboard', 'catalog.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

// GET：返回本项目全部「无限・秩影」视频记录（params 已解码）
export async function GET(_req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const assets = Assets.list(id, 'video');
  return NextResponse.json(assets.map((a) => ({ ...a, params: a.params || {} })));
}

// 把用户上传的素材（uploads/ 下）复制进影片工作区 film/materials/，并返回
// 供 Agent 使用的 film 相对路径清单 + 供落库的 project 相对路径清单。
function stageMaterials(projectId, references) {
  const stored = [];
  const agent = [];
  for (const r of references || []) {
    const rel = String(r.filename || r.path || '').trim();
    if (!rel) continue;
    const srcAbs = resolveProjectPath(projectId, rel);
    if (!srcAbs || !fs.existsSync(srcAbs)) throw new Error('素材不存在：' + rel);
    const ext = path.extname(rel);
    const base = path.basename(rel, ext) || 'mat';
    const finalName = slugify(base) + '_' + uid().slice(0, 6) + ext;
    const destRel = 'film/materials/' + finalName;
    const destAbs = resolveProjectPath(projectId, destRel);
    if (!destAbs) throw new Error('素材路径非法');
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
    const type = ['image', 'audio', 'video', 'file'].includes(r.type) ? r.type : 'file';
    stored.push({ type, filename: destRel, name: r.name || path.basename(rel) });
    agent.push({ type, filename: 'materials/' + finalName, name: r.name || path.basename(rel) });
  }
  return { stored, agent };
}

// POST：创建（或 asset_id 重新生成）无限・秩影生成任务
export async function POST(req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const { style_slug = '', custom_style = '', prompt = '', references = [], name = '', asset_id = '' } = body || {};
  if (!String(prompt || '').trim()) return NextResponse.json({ error: '缺少提示词 prompt' }, { status: 400 });
  if (!style_slug) return NextResponse.json({ error: '缺少风格 style_slug' }, { status: 400 });
  if (!Array.isArray(references)) return NextResponse.json({ error: 'references 必须是数组' }, { status: 400 });

  const isCustom = style_slug === '__custom__';
  let style = null;
  if (isCustom) {
    if (!String(custom_style || '').trim()) return NextResponse.json({ error: '缺少自定义风格描述 custom_style' }, { status: 400 });
  } else {
    const catalog = loadCatalog();
    style = catalog.find((s) => s.slug === style_slug);
    if (!style) return NextResponse.json({ error: '风格不存在：' + style_slug }, { status: 400 });
  }

  let materials;
  let storedRefs;
  try {
    ({ stored: storedRefs, agent: materials } = stageMaterials(id, references));
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }

  const styleInfo = isCustom
    ? { cn: '自定义风格', en: 'Custom', cat: '自定义', custom_style: String(custom_style || '').trim() }
    : { cn: style.cn, en: style.en, cat: style.cat, cat_en: style.cat_en, line_cn: style.line_cn };

  let asset;
  if (asset_id) {
    asset = Assets.get(asset_id);
    if (!asset || asset.project_id !== id || asset.category !== 'video') return NextResponse.json({ error: '记录不存在' }, { status: 404 });
  } else {
    asset = Assets.create(id, { category: 'video', name: name || ('秩影-' + (styleInfo.cn || style_slug) + '-' + uid().slice(0, 6)) });
  }

  const paramsObj = isCustom
    ? { style_slug: '__custom__', style_cn: '自定义风格', style_en: 'Custom', cat: '自定义', custom_style: String(custom_style || '').trim(), references: storedRefs }
    : { style_slug, style_cn: style.cn, style_en: style.en, cat: style.cat, references: storedRefs };
  withWriteContext('POST /api/projects/:id/opuscar', () => {
    Assets.update(asset.id, { status: 'generating', prompt: String(prompt || ''), name: name || asset.name, params: paramsObj });
  });

  const job = startOpuscarJob({
    projectId: id,
    assetId: asset.id,
    styleSlug: style_slug,
    styleInfo,
    prompt: String(prompt || ''),
    materials,
    onProgress: (patch) => broadcast(patch),
  });
  return NextResponse.json(job);
}
