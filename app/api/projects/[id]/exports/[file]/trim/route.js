// 成片轻量剪辑：GET 探测时长，POST 按「保留选区 / 删除选区」生成新成片（不覆盖原片）。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, projectDir, probeVideoInfo, cutVideo, uid } from '@/lib/core/index.js';
import { runInlineJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;

function target(id, file) {
  const name = path.basename(String(file || ''));
  if (!name || name !== String(file || '') || !VIDEO_RE.test(name)) return null;
  if (!Projects.get(id)) return 'no-project';
  const abs = path.join(projectDir(id), 'exports', name);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return 'missing';
  return { name, abs, ext: path.extname(name) };
}

export async function GET(_req, { params }) {
  const { id, file } = await params;
  const t = target(id, file);
  if (!t) return NextResponse.json({ error: '非法文件名' }, { status: 400 });
  if (t === 'no-project') return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (t === 'missing') return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  try {
    const info = await probeVideoInfo(t.abs);
    return NextResponse.json({ duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  const { id, file } = await params;
  const t = target(id, file);
  if (!t) return NextResponse.json({ error: '非法文件名' }, { status: 400 });
  if (t === 'no-project') return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (t === 'missing') return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  try {
    const body = await req.json().catch(() => ({}));
    const mode = body?.mode === 'keep' ? 'keep' : 'cut';
    const s = Number(body?.startSec);
    const e = Number(body?.endSec);
    if (!Number.isFinite(s) || s < 0 || !Number.isFinite(e) || e <= s) {
      return NextResponse.json({ error: '选区无效：终点必须大于起点' }, { status: 400 });
    }
    const info = await probeVideoInfo(t.abs);
    if (info.duration && e > info.duration + 0.01) {
      return NextResponse.json({ error: '选区超出视频时长（' + info.duration.toFixed(1) + ' 秒）' }, { status: 400 });
    }

    const exportsDir = path.join(projectDir(id), 'exports');
    const backupsDir = path.join(projectDir(id), 'backups');
    let backupName = '';
    if (body?.backup !== false) {
      fs.mkdirSync(backupsDir, { recursive: true });
      backupName = path.basename(t.name, t.ext) + '_备份_' + Date.now() + t.ext;
      fs.copyFileSync(t.abs, path.join(backupsDir, backupName));
    }
    const base = path.basename(t.name, t.ext);
    const outName = base + '_剪辑_' + (mode === 'keep' ? '保留' : '删除') + '_' +
      s.toFixed(3).replace('.', 'p') + '-' + e.toFixed(3).replace('.', 'p') + '_' + uid().slice(0, 8) + '.mp4';
    const outAbs = path.join(exportsDir, outName);

    await runInlineJob(
      { projectId: id, type: 'export', checkpoint: { subject: t.name }, onProgress: (p) => broadcast(p) },
      async (emit) => {
        emit({ phase: '剪辑', detail: (mode === 'keep' ? '保留' : '删除') + ' ' + s.toFixed(1) + '–' + e.toFixed(1) + ' 秒' });
        await cutVideo(t.abs, outAbs, { startSec: s, endSec: e, mode });
        return outName;
      },
    );

    return NextResponse.json({
      name: outName,
      rel: 'exports/' + outName,
      url: '/files/projects/' + id + '/exports/' + outName,
      size: fs.statSync(outAbs).size,
      backup: backupName,
      backup_url: backupName ? '/files/projects/' + id + '/backups/' + backupName : '',
      mode, startSec: s, endSec: e,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
