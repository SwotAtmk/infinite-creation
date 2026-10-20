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
    const all = fs.readdirSync(dir);
    const has = new Set(all);
    const isNoSub = (f) => /_nosub\.[^.]+$/i.test(f);
    files = all
      .filter((f) => /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(f))
      // 「不带字幕」的副本是带字幕成片的配套文件：并进主条目的下载按钮，不单独占一行；
      // 主文件被删后，孤儿副本仍照常列出，避免文件在界面里彻底消失。
      .filter((f) => !isNoSub(f) || !has.has(f.replace(/_nosub(\.[^.]+)$/i, '$1')))
      .map((f) => {
        const abs = path.join(dir, f);
        const st = fs.statSync(abs);
        const nosubName = f.replace(/(\.[^.]+)$/, '_nosub$1');
        const hasNoSub = !isNoSub(f) && has.has(nosubName);
        // SRT 同样不作为独立条目出现，只给主视频提供「下载字幕」按钮
        const srtName = f.replace(/\.[^.]+$/, '.srt');
        return {
          name: f, rel: 'exports/' + f, url: '/files/projects/' + id + '/exports/' + f, size: st.size, mtime: st.mtimeMs,
          nosub_name: hasNoSub ? nosubName : '',
          srt_name: has.has(srtName) ? srtName : '',
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {}
  return NextResponse.json({ files });
}

// 删除成片（支持批量）：body = { files: ['xxx.mp4', ...] }。
// 主视频被删时一并清掉配套的「不带字幕」副本与 SRT 字幕，否则它们会变成界面上看不见的孤儿文件
// （副本本身不单独列条目）。文件名只认导出目录下的纯文件名，杜绝路径穿越。
export async function DELETE(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const names = Array.isArray(body?.files) ? body.files : [];
  if (!names.length) return NextResponse.json({ error: '缺少要删除的文件名' }, { status: 400 });
  const dir = path.join(projectDir(id), 'exports');
  const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;
  const deleted = [];
  const missing = [];
  const rejected = [];
  const failed = [];
  for (const raw of names) {
    const name = String(raw ?? '');
    // basename 收敛：'a/b.mp4'、'../x.mp4' 这类一律拒绝，而不是悄悄删掉别的文件
    if (!name || path.basename(name) !== name || !VIDEO_RE.test(name)) { rejected.push(name); continue; }
    if (!fs.existsSync(path.join(dir, name))) { missing.push(name); continue; }
    for (const f of [name, name.replace(/(\.[^.]+)$/, '_nosub$1'), name.replace(/\.[^.]+$/, '.srt')]) {
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch { failed.push(f); }
    }
    deleted.push(name);
  }
  return NextResponse.json({ deleted, missing, rejected, failed });
}
