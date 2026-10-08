// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { ReferenceImages, Assets, resolveProjectPath, slugify, uid, ensureProjectDirs } from '@/lib/core/index.js';
import { PROJECT_ASSET_SUBDIRS } from '@/lib/shared/index.js';

export const dynamic = 'force-dynamic';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 9;

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
  const baseName = (name || (orig && path.basename(orig, extName)) || 'reference').trim();
  const relDir = mode === 'library' ? ('assets/' + (PROJECT_ASSET_SUBDIRS[category] || 'other') + '/') : 'references/';
  const rel = relDir + slugify(baseName) + '_' + uid().slice(0, 8) + extName;
  const abs = resolveProjectPath(id, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);

  let asset = null;
  if (mode === 'library') {
    asset = Assets.create(id, { category, name: baseName, description: '' });
    Assets.update(asset.id, { image_path: rel, source: 'uploaded', status: 'done' });
  }
  const reference = ReferenceImages.create(id, {
    chapter_id,
    asset_id: asset ? asset.id : '',
    name: baseName,
    image_path: rel,
    mode,
    category,
    description: '',
  });
  return NextResponse.json({ reference, asset });
}
