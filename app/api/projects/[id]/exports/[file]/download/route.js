// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, projectDir } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id, file } = await params;
  // id 来自 URL 且会被解码（可含 '..'），projectDir 不做边界校验：
  // 不确认项目存在就能用穿越 id 把下载目录指到项目外。file 已下文的 basename 收敛。
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const name = path.basename(file || '');
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return NextResponse.json({ error: '非法文件名' }, { status: 400 });
  const abs = path.join(projectDir(id), 'exports', name);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  const buf = fs.readFileSync(abs);
  return new NextResponse(buf, {
    headers: {
      // SRT 是纯文本字幕，按规范类型返回（浏览器下载时仍按 UTF-8 文件名落盘）
      'Content-Type': /\.srt$/i.test(name) ? 'application/x-subrip; charset=utf-8' : 'video/mp4',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
    },
  });
}
