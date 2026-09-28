// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
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
