// 镜头切换点：用 ffmpeg scene 检测找切镜时间，前端再抽帧出缩略图。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, projectDir, detectSceneChanges, probeVideoInfo } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;

export async function GET(_req, { params }) {
  const { id, file } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const name = path.basename(String(file || ''));
  if (!name || name !== String(file || '') || !VIDEO_RE.test(name)) return NextResponse.json({ error: '非法文件名' }, { status: 400 });
  const abs = path.join(projectDir(id), 'exports', name);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  try {
    const url = new URL(_req.url);
    const threshold = Math.max(0.05, Math.min(0.9, Number(url.searchParams.get('threshold')) || 0.3));
    const info = await probeVideoInfo(abs);
    const times = await detectSceneChanges(abs, { threshold });
    const scenes = times.slice(0, 40).map((t) => ({
      time: +t.toFixed(4),
      frame: Math.round(t * (info.fps || 24)),
    }));
    return NextResponse.json({ scenes, threshold, fps: info.fps || 24 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
