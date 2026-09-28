// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Assets, slugify, uid, resolveProjectPath } from '@/lib/core/index.js';
import { PROJECT_ASSET_SUBDIRS } from '@/lib/shared/index.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, aid } = await params;
  const asset = Assets.get(aid);
  if (!asset || asset.project_id !== id) return NextResponse.json({ error: '资产不存在' }, { status: 404 });
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return NextResponse.json({ error: '缺少文件内容' }, { status: 400 });
  const orig = decodeURIComponent(req.headers.get('x-filename') || '');
  const extName = (orig && path.extname(orig) || '').toLowerCase();
  const isAudio = ['voice', 'music', 'sfx'].includes(asset.category);
  const isVideo = asset.category === 'video' || /\.(mp4|webm|mov|avi|mkv|m4v|gif)$/i.test(extName);
  const ext = extName || (isVideo ? '.mp4' : (isAudio ? '.wav' : '.png'));
  const subdir = PROJECT_ASSET_SUBDIRS[asset.category] || 'other';
  const rel = 'assets/' + subdir + '/' + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
  const abs = resolveProjectPath(id, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  if (asset.category === 'voice') Assets.update(asset.id, { voice_ref: rel, audio_path: rel, source: 'uploaded', status: 'done' });
  else if (isVideo) Assets.update(asset.id, { video_path: rel, source: 'uploaded', status: 'done' });
  else if (isAudio) Assets.update(asset.id, { audio_path: rel, source: 'uploaded', status: 'done' });
  else Assets.update(asset.id, { image_path: rel, source: 'uploaded', status: 'done' });
  return NextResponse.json({ asset_id: asset.id, path: rel });
}
