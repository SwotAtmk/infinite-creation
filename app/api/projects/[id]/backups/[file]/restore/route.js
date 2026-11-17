// 从备份还原：复制回 exports/ 作为一条新成片，不覆盖当前任何文件。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, projectDir, uid } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;

export async function POST(_req, { params }) {
  const { id, file } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const name = path.basename(String(file || ''));
  if (!name || name !== String(file || '') || !VIDEO_RE.test(name)) return NextResponse.json({ error: '非法文件名' }, { status: 400 });
  const abs = path.join(projectDir(id), 'backups', name);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return NextResponse.json({ error: '备份不存在' }, { status: 404 });
  try {
    const exportsDir = path.join(projectDir(id), 'exports');
    fs.mkdirSync(exportsDir, { recursive: true });
    const ext = path.extname(name);
    const outName = path.basename(name, ext).replace(/_备份_\d+$/, '') + '_还原_' + uid().slice(0, 8) + ext;
    fs.copyFileSync(abs, path.join(exportsDir, outName));
    return NextResponse.json({
      name: outName,
      rel: 'exports/' + outName,
      url: '/files/projects/' + id + '/exports/' + outName,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
