// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 无限・秩影：返回某个风格的预览海报图（styles/<slug>/poster.jpg）。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const slug = new URL(req.url).searchParams.get('slug') || '';
  if (!/^[a-z0-9-]+$/.test(slug)) return NextResponse.json({ error: '非法 slug' }, { status: 400 });
  const file = path.join(SKILLS_DIR, 'lemo-opuscar', 'styles', slug, 'poster.jpg');
  if (!fs.existsSync(file)) return NextResponse.json({ error: '无预览图' }, { status: 404 });
  const buf = fs.readFileSync(file);
  return new NextResponse(buf, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
}
