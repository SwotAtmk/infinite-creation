// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 无限・秩影记录：GET 列表 / POST 创建（asset_id 重新生成 / message 继续对话修改）生成任务。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, Assets, Jobs, SKILLS_DIR, uid, slugify, resolveProjectPath, withWriteContext } from '@/lib/core/index.js';
import { startOpuscarJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

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

// GET：返回本项目全部「无限・秩影」视频记录（params 已解码，含对话 chat）
export async function GET(_req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const assets = Assets.list(id, 'video');
  return NextResponse.json(assets.map((a) => ({ ...a, params: a.params || {} })));
}

// 把一条素材复制进该记录的影片工作区 film/<assetId>/materials/，
// 返回供落库的 project 相对路径 + 供 Agent 使用的 film 相对路径。
function stageOne(projectId, assetId, r) {
  const rel = String(r.filename || r.path || '').trim();
  if (!rel) return null;
  const srcAbs = resolveProjectPath(projectId, rel);
  if (!srcAbs || !fs.existsSync(srcAbs)) throw new Error('素材不存在：' + rel);
  const ext = path.extname(rel);
  const base = path.basename(rel, ext) || 'mat';
  const finalName = slugify(base) + '_' + uid().slice(0, 6) + ext;
  const destRel = 'film/' + assetId + '/materials/' + finalName;
  const destAbs = resolveProjectPath(projectId, destRel);
  if (!destAbs) throw new Error('素材路径非法');
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
  const type = ['image', 'audio', 'video', 'file'].includes(r.type) ? r.type : 'file';
  return {
    stored: { type, filename: destRel, name: r.name || path.basename(rel) },
    agent: { type, filename: 'materials/' + finalName, name: r.name || path.basename(rel) },
  };
}

function stageMaterials(projectId, assetId, references) {
  const stored = [];
  const agent = [];
  for (const r of references || []) {
    const s = stageOne(projectId, assetId, r);
    if (!s) continue;
    stored.push(s.stored);
    agent.push(s.agent);
  }
  return { stored, agent };
}

// 继续对话时复用已有素材：已在本记录工作区里的直接沿用；早先落在项目级 film/materials/
// 的旧路径复制进本记录工作区，保证 Agent 看到的 film 内相对路径始终有效。
function reuseMaterials(projectId, assetId, references) {
  const prefix = 'film/' + assetId + '/materials/';
  const stored = [];
  const agent = [];
  for (const r of references || []) {
    const rel = String(r.filename || r.path || '').trim();
    if (!rel) continue;
    const type = ['image', 'audio', 'video', 'file'].includes(r.type) ? r.type : 'file';
    if (rel.startsWith(prefix)) {
      stored.push({ type, filename: rel, name: r.name || '' });
      agent.push({ type, filename: 'materials/' + rel.slice(prefix.length), name: r.name || '' });
      continue;
    }
    const s = stageOne(projectId, assetId, r);
    if (!s) continue;
    stored.push(s.stored);
    agent.push(s.agent);
  }
  return { stored, agent };
}

// POST：创建 / 重新生成 / 继续修改「无限・秩影」生成任务
export async function POST(req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const { style_slug = '', custom_style = '', prompt = '', references = [], name = '', asset_id = '', message = '' } = body || {};
  if (references !== undefined && !Array.isArray(references)) return NextResponse.json({ error: 'references 必须是数组' }, { status: 400 });

  // ── 继续对话：在已有记录上追加一条修改要求，复用风格/素材与上一版工作区 ──
  if (asset_id && String(message || '').trim()) {
    const asset = Assets.get(asset_id);
    if (!asset || asset.project_id !== id || asset.category !== 'video') return NextResponse.json({ error: '记录不存在' }, { status: 404 });
    const active = activeOpuscarJob(id, asset_id);
    if (active) return NextResponse.json({ error: '该记录正在生成中，请等它结束或先停止', code: 'ALREADY_RENDERING', jobId: active.id }, { status: 409 });

    const old = asset.params || {};
    if (!old.style_slug) return NextResponse.json({ error: '该记录缺少风格信息，无法继续修改' }, { status: 400 });
    const isCustom = old.style_slug === '__custom__';
    const styleInfo = isCustom
      ? { cn: '自定义风格', en: 'Custom', cat: '自定义', custom_style: old.custom_style || '' }
      : { cn: old.style_cn || old.style_slug, en: old.style_en || '', cat: old.cat || '' };
    let reused;
    try {
      reused = reuseMaterials(id, asset_id, old.references || []);
    } catch (e) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    const chatItem = { role: 'user', text: String(message).trim(), at: Date.now() };
    const historyChat = Array.isArray(old.chat) ? old.chat.slice() : [];
    // 旧记录（以及本次改动之前跑的轮次）没有按轮记录成片：续改前把当前成片补记到上一轮，
    // 否则新轮次一出现，上一轮就成了「没有产出」的历史。
    if (historyChat.length && asset.video_path) {
      const last = historyChat[historyChat.length - 1];
      if (!last.video_path && last.status !== 'failed' && last.status !== 'cancelled') {
        historyChat[historyChat.length - 1] = { ...last, video_path: asset.video_path, status: last.status || 'done', finished_at: last.finished_at || asset.updated_at };
      }
    }
    const chat = [...historyChat, chatItem];
    const turn = chat.length - 1;
    const nextParams = { ...old, references: reused.stored, chat };
    withWriteContext('POST /api/projects/:id/opuscar (continue)', () => {
      Assets.update(asset_id, { status: 'generating', params: nextParams });
    });
    const job = startOpuscarJob({
      projectId: id,
      assetId: asset_id,
      styleSlug: old.style_slug,
      styleInfo,
      prompt: asset.prompt || '',
      materials: reused.agent,
      history: chat.slice(0, -1),
      continueMessage: String(message).trim(),
      turn,
      onProgress: (patch) => broadcast(patch),
    });
    return NextResponse.json(job);
  }

  // ── 创建 / 重新生成 ──
  if (!String(prompt || '').trim()) return NextResponse.json({ error: '缺少提示词 prompt' }, { status: 400 });
  if (!style_slug) return NextResponse.json({ error: '缺少风格 style_slug' }, { status: 400 });

  const isCustom = style_slug === '__custom__';
  let style = null;
  if (isCustom) {
    if (!String(custom_style || '').trim()) return NextResponse.json({ error: '缺少自定义风格描述 custom_style' }, { status: 400 });
  } else {
    const catalog = loadCatalog();
    style = catalog.find((s) => s.slug === style_slug);
    if (!style) return NextResponse.json({ error: '风格不存在：' + style_slug }, { status: 400 });
  }

  let asset;
  let created = false;
  if (asset_id) {
    asset = Assets.get(asset_id);
    if (!asset || asset.project_id !== id || asset.category !== 'video') return NextResponse.json({ error: '记录不存在' }, { status: 404 });
    const active = activeOpuscarJob(id, asset_id);
    if (active) return NextResponse.json({ error: '该记录正在生成中，请等它结束或先停止', code: 'ALREADY_RENDERING', jobId: active.id }, { status: 409 });
  } else {
    asset = Assets.create(id, { category: 'video', name: name || ('秩影-' + (isCustom ? '自定义风格' : style.cn) + '-' + uid().slice(0, 6)) });
    created = true;
  }

  const styleInfo = isCustom
    ? { cn: '自定义风格', en: 'Custom', cat: '自定义', custom_style: String(custom_style || '').trim() }
    : { cn: style.cn, en: style.en, cat: style.cat, cat_en: style.cat_en, line_cn: style.line_cn };

  let materials;
  let storedRefs;
  try {
    ({ stored: storedRefs, agent: materials } = stageMaterials(id, asset.id, references));
  } catch (e) {
    // 新建记录时素材来自用户上传，失败就清掉刚建的空记录，避免留下一条永远无法生成的僵尸行。
    if (created) { try { Assets.remove(asset.id); } catch { /* 清理失败不掩盖原始错误 */ } }
    return NextResponse.json({ error: e.message }, { status: 400 });
  }

  const paramsObj = isCustom
    ? { style_slug: '__custom__', style_cn: '自定义风格', style_en: 'Custom', cat: '自定义', custom_style: String(custom_style || '').trim(), references: storedRefs }
    : { style_slug, style_cn: style.cn, style_en: style.en, cat: style.cat, references: storedRefs };
  // 新一轮生成重置对话：初始提示词就是第一条用户消息（重新生成同理）。
  paramsObj.chat = [{ role: 'user', text: String(prompt || ''), at: Date.now() }];
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
    turn: 0,
    onProgress: (patch) => broadcast(patch),
  });
  return NextResponse.json(job);
}
