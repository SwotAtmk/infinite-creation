// 手动备份单个成片：复制到项目下 backups/，原片不动。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, projectDir } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;

export async function POST(_req, { params }) {
  const { id, file } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const name = path.basename(String(file || ''));
  if (!name || name !== String(file || '') || !VIDEO_RE.test(name)) return NextResponse.json({ error: '非法文件名' }, { status: 400 });
  const abs = path.join(projectDir(id), 'exports', name);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  try {
    const backupsDir = path.join(projectDir(id), 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const ext = path.extname(name);
    const backupName = path.basename(name, ext) + '_备份_' + Date.now() + ext;
    fs.copyFileSync(abs, path.join(backupsDir, backupName));
    return NextResponse.json({
      name: backupName,
      url: '/files/projects/' + id + '/backups/' + backupName,
      size: fs.statSync(path.join(backupsDir, backupName)).size,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
