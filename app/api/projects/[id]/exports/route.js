// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, projectDir } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  // id 来自 URL，Next 的 route handler 会把 %2e%2e 解码成 '..'（vercel/next.js#64952）；
  // projectDir 只是 path.join(PROJECTS_DIR, id)，不校验就 readdir 可越界列出任意目录。
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const dir = path.join(projectDir(id), 'exports');
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(f))
      .map((f) => {
        const abs = path.join(dir, f);
        const st = fs.statSync(abs);
        return { name: f, rel: 'exports/' + f, url: '/files/projects/' + id + '/exports/' + f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {}
  return NextResponse.json({ files });
}
