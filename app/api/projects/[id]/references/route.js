// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { ReferenceImages, Assets, resolveProjectPath, slugify, uid, ensureProjectDirs, loadConfig, llmChat, extractJson, buildVisionUserMessage, logger } from '@/lib/core/index.js';
import { runInlineJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';
import { PROJECT_ASSET_SUBDIRS } from '@/lib/shared/index.js';

export const dynamic = 'force-dynamic';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 9;

// 用 LLM 视觉模型分析上传图片，返回 { name, category, description }；
// 未配置 vision 或分析失败时返回 null（静默降级回原文件名），绝不让分析拖垮上传。
async function analyzeUploadedImage(buf, extName) {
  try {
    const cfg = loadConfig();
    if (!cfg.llm?.vision || !cfg.llm?.apiKey) return null;
    const mimeType = IMAGE_MIME[extName];
    if (!mimeType) return null;
    const dataUrl = 'data:' + mimeType + ';base64,' + buf.toString('base64');
    const messages = [
      { role: 'system', content: '你是视频素材命名助手。根据图片内容，输出一个简洁准确的中文素材名、所属分类和一句话用途描述。只输出 JSON。' },
      buildVisionUserMessage('请分析这张图片，只返回 JSON：{"name":"素材名（中文，2-8字，概括主体，如「红衣少女」「江南小镇」）","category":"character|scene|prop|other 之一（人物=character，场景/背景=scene，道具/物品=prop，其它=other）","description":"一句话描述图片内容及其适合用于剧情的哪个位置"}', [dataUrl]),
    ];
    const resp = await llmChat(cfg.llm, messages, { json: true, temperature: 0.3, maxTokens: 300, timeoutMs: 30000 });
    const info = extractJson(resp.content);
    const name = String(info.name || '').trim().slice(0, 40);
    if (!name) return null;
    const category = PROJECT_ASSET_SUBDIRS[info.category] ? info.category : 'other';
    const description = String(info.description || '').trim().slice(0, 200);
    return { name, category, description };
  } catch (e) {
    logger.warn('参考图 LLM 分析失败，回退原文件名', { error: e.message });
    return null;
  }
}

export async function GET(req, { params }) {
  const { id } = await params;
  const url = new URL(req.url);
  const chapterId = url.searchParams.get('chapter_id') || null;
  const mode = url.searchParams.get('mode') || null;
  return NextResponse.json(ReferenceImages.list(id, { chapterId, mode }));
}

export async function POST(req, { params }) {
  const { id } = await params;
  const fd = await req.formData().catch(() => null);
  if (!fd) return NextResponse.json({ error: '缺少表单数据' }, { status: 400 });
  const file = fd.get('file');
  const mode = fd.get('mode') === 'library' ? 'library' : 'reference';
  const category = String(fd.get('category') || 'other');
  const chapter_id = String(fd.get('chapter_id') || '');
  const name = String(fd.get('name') || '');
  const description = String(fd.get('description') || '');
  if (!file || typeof file.arrayBuffer !== 'function') return NextResponse.json({ error: '缺少文件' }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  if (!buf.length) return NextResponse.json({ error: '缺少文件内容' }, { status: 400 });
  if (buf.length > MAX_BYTES) return NextResponse.json({ error: '图片超过 10MB' }, { status: 400 });
  const orig = file.name || name || '';
  const extName = (orig && path.extname(orig) || '').toLowerCase();
  if (!IMAGE_EXTS.has(extName)) return NextResponse.json({ error: '仅支持 png/jpg/jpeg/webp/gif 图片' }, { status: 400 });

  if (ReferenceImages.list(id).length >= MAX_IMAGES) {
    return NextResponse.json({ error: '参考图片最多 ' + MAX_IMAGES + ' 张' }, { status: 400 });
  }

  ensureProjectDirs(id);
  // 视觉分析命名：优先用 LLM 生成的素材名，失败/未配置时回退原文件名。
  // 仅在确实会调用 LLM（配置了 vision + apiKey）时记一条任务，使其出现在任务列表。
  const cfgForAnalyze = loadConfig();
  const willAnalyze = !!(cfgForAnalyze.llm?.vision && cfgForAnalyze.llm?.apiKey);
  const analysis = willAnalyze
    ? await runInlineJob(
        { projectId: id, type: 'llm', checkpoint: { subject: name || orig || 'reference' }, onProgress: (p) => broadcast(p) },
        () => analyzeUploadedImage(buf, extName),
      )
    : null;
  const baseName = (analysis?.name || name || (orig && path.basename(orig, extName)) || 'reference').trim();
  // 分类：用户显式选了非「其他」时尊重用户；否则采纳 LLM 推断（默认 other）
  const analyzedCategory = (analysis && analysis.category) || 'other';
  const assetCategory = mode === 'library' ? ((category && category !== 'other') ? category : analyzedCategory) : category;
  const finalDescription = (analysis?.description || description || '').trim();
  const relDir = mode === 'library' ? ('assets/' + (PROJECT_ASSET_SUBDIRS[assetCategory] || 'other') + '/') : 'references/';
  const rel = relDir + slugify(baseName) + '_' + uid().slice(0, 8) + extName;
  const abs = resolveProjectPath(id, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);

  let asset = null;
  if (mode === 'library') {
    asset = Assets.create(id, { category: assetCategory, name: baseName, description: finalDescription });
    Assets.update(asset.id, { image_path: rel, source: 'uploaded', status: 'done' });
  }
  const reference = ReferenceImages.create(id, {
    chapter_id,
    asset_id: asset ? asset.id : '',
    name: baseName,
    image_path: rel,
    mode,
    category: assetCategory,
    description: finalDescription,
  });
  return NextResponse.json({ reference, asset });
}
