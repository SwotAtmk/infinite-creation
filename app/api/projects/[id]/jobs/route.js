// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, Shots, Assets, Chapters, projectDir } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const CATEGORY_LABEL = { character: '角色', scene: '场景', prop: '道具', costume: '服装', age: '年龄', voice: '语音', music: '音乐', sfx: '音效', other: '其他' };

// 把任务的 checkpoint.subject（分镜/资产 id、章节名、阶段名、文件名…）解析成用户可读的目标标签
function subjectLabel(subject, ref) {
  if (!subject) return '';
  const s = String(subject);
  const shot = ref.shots.find((x) => x.id === s);
  if (shot) return '分镜 ' + shot.idx + (shot.scene_name ? '（' + shot.scene_name + '）' : '') + (shot.chapter ? ' · ' + shot.chapter : '');
  const asset = ref.assets.find((x) => x.id === s);
  if (asset) return asset.name + '（' + (CATEGORY_LABEL[asset.category] || asset.category) + '）';
  const ch = ref.chapters.find((c) => c.title === s || c.id === s);
  if (ch) return '章节「' + ch.title + '」';
  return s.slice(0, 40); // 阶段名 / 文件名等直接展示
}

export async function GET(_req, { params }) {
  const { id } = await params;
  const jobs = Jobs.list(id);
  const ref = { shots: Shots.list(id), assets: Assets.list(id), chapters: Chapters.list(id) };
  return NextResponse.json(jobs.map((j) => ({ ...j, subjectLabel: subjectLabel(j.checkpoint && j.checkpoint.subject, ref) })));
}

// 清除已结束任务（完成/失败/已取消/已中断）：只删记录与日志，不动活动任务、不动素材/成片。
export async function DELETE(_req, { params }) {
  const { id } = await params;
  const finished = Jobs.list(id).filter((j) => j.status !== 'running' && j.status !== 'queued');
  for (const j of finished) {
    try { fs.unlinkSync(path.join(projectDir(id), 'logs', j.id + '.log')); } catch {}
    if (j.logPath) { try { fs.unlinkSync(j.logPath); } catch {} }
    Jobs.remove(j.id);
  }
  return NextResponse.json({ removed: finished.length });
}
