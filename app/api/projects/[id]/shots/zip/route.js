// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Shots, Projects, resolveProjectPath, slugify } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  const { id } = await params;
  try {
    const url = new URL(req.url);
    const chapter = url.searchParams.get('chapter') || '';
    let shots = Shots.list(id).filter((s) => s.video_path && s.status === 'done');
    if (chapter) shots = shots.filter((s) => s.chapter === chapter);
    if (!shots.length) return NextResponse.json({ error: chapter ? ('章节「' + chapter + '」没有已完成的视频片段') : '没有已完成的视频片段' }, { status: 400 });
    // 按章节 + 序号排序，保证解压后顺序稳定
    shots.sort((a, b) => {
      const ca = a.chapter || '', cb = b.chapter || '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return (a.idx ?? 0) - (b.idx ?? 0);
    });

    const zip = new AdmZip();
    const used = new Set();
    for (const s of shots) {
      const abs = resolveProjectPath(id, s.video_path);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      const ext = path.extname(s.video_path);
      const folder = slugify(s.chapter || '默认') || '默认';
      const scene = slugify(s.scene_name || '');
      const stem = String(s.idx ?? 0).padStart(3, '0') + (scene ? '_' + scene : '');
      let entryName = stem + ext;
      let n = 1;
      while (used.has(folder + '/' + entryName)) entryName = stem + '_' + (n++) + ext;
      used.add(folder + '/' + entryName);
      zip.addLocalFile(abs, folder, entryName);
    }
    if (!zip.getEntries().length) return NextResponse.json({ error: '视频片段文件缺失，无法打包' }, { status: 500 });

    const p = Projects.get(id);
    const zipBase = slugify(p?.name || 'project') + '_' + (chapter ? slugify(chapter) : '全部章节') + '_片段';
    const buf = zip.toBuffer();
    return new NextResponse(buf, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(zipBase + '.zip'),
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
