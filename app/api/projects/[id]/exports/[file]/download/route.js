// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id, file } = await params;
  const name = path.basename(file || '');
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return NextResponse.json({ error: '非法文件名' }, { status: 400 });
  const abs = path.join(projectDir(id), 'exports', name);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  const buf = fs.readFileSync(abs);
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
    },
  });
}
