// 备份列表 / 删除备份。媒体文件仍按项目现有口径不入库，直接扫项目下 backups/ 目录。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, projectDir } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;

export async function GET(_req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const dir = path.join(projectDir(id), 'backups');
  let files = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    files = fs.readdirSync(dir)
      .filter((f) => VIDEO_RE.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return {
          name: f,
          rel: 'backups/' + f,
          url: '/files/projects/' + id + '/backups/' + f,
          size: st.size,
          mtime: st.mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {}
  return NextResponse.json({ files });
}

export async function DELETE(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const names = Array.isArray(body?.files) ? body.files : [];
  if (!names.length) return NextResponse.json({ error: '缺少要删除的备份文件名' }, { status: 400 });
  const dir = path.join(projectDir(id), 'backups');
  const deleted = [], missing = [], rejected = [], failed = [];
  for (const raw of names) {
    const name = String(raw ?? '');
    if (!name || path.basename(name) !== name || !VIDEO_RE.test(name)) { rejected.push(name); continue; }
    const abs = path.join(dir, name);
    if (!fs.existsSync(abs)) { missing.push(name); continue; }
    try { fs.rmSync(abs, { force: true }); deleted.push(name); } catch { failed.push(name); }
  }
  return NextResponse.json({ deleted, missing, rejected, failed });
}
