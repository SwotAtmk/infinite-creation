// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 通用媒体上传：供简单模式页（视频生成 / 数字人）上传参考图片、驱动音频、参考视频等物料。
// 与 references（仅图片、需章节）和 assets/:aid/upload（需先建资产）不同，这里只落盘并返回
// 相对路径 + 媒体类型，供后续「视频生成」等接口引用。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, slugify, uid, resolveProjectPath, ensureProjectDirs } from '@/lib/core/index.js';
import { UPLOAD_MAX_BYTES, REFERENCE_IMAGE_EXTS, AUDIO_EXT_RE, VIDEO_EXT_RE } from '@/lib/shared/index.js';

export const dynamic = 'force-dynamic';

function mediaKind(ext) {
  if (VIDEO_EXT_RE.test(ext)) return 'video';
  if (AUDIO_EXT_RE.test(ext)) return 'audio';
  if (REFERENCE_IMAGE_EXTS.includes(ext)) return 'image';
  return null;
}

export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const fd = await req.formData().catch(() => null);
  if (!fd) return NextResponse.json({ error: '缺少表单数据' }, { status: 400 });
  const file = fd.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return NextResponse.json({ error: '缺少文件' }, { status: 400 });

  const orig = String(file.name || '');
  const ext = (orig && path.extname(orig) || '').toLowerCase();
  const kind = mediaKind(ext);
  if (!kind) return NextResponse.json({ error: '不支持的文件类型：仅支持图片/音频/视频' }, { status: 400 });

  const limit = UPLOAD_MAX_BYTES[kind];
  const buf = Buffer.from(await file.arrayBuffer());
  if (!buf.length) return NextResponse.json({ error: '缺少文件内容' }, { status: 400 });
  if (buf.length > limit) return NextResponse.json({ error: '文件过大：这类素材上限 ' + Math.round(limit / 1024 / 1024) + 'MB' }, { status: 413 });

  ensureProjectDirs(id);
  const base = String(orig && path.basename(orig, ext) || 'media').trim() || 'media';
  const rel = 'uploads/' + slugify(base) + '_' + uid().slice(0, 8) + ext;
  const abs = resolveProjectPath(id, rel);
  if (!abs) return NextResponse.json({ error: '非法保存路径' }, { status: 400 });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return NextResponse.json({ path: rel, kind });
}
