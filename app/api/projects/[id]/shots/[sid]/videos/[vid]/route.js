// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Shots, ShotVideos } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

// 删除某条候选视频。候选与选中态都是渲染产物（不进 changelog），
// 只保证删除后 shots.video_path 仍指向一条有效候选：
//   - 删的是选中项且还有别的候选 → 自动改选剩下的第一条；
//   - 删完最后一条 → 分镜回到待生成（video_path 清空），导出/合成不会指向已删文件。
export async function DELETE(_req, { params }) {
  const { id, sid, vid } = await params;
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
  const video = ShotVideos.get(vid);
  if (!video || video.shot_id !== sid) return NextResponse.json({ error: '候选视频不存在' }, { status: 404 });

  ShotVideos.remove(vid);
  const rest = ShotVideos.listByShot(sid);
  const picked = rest.find((v) => v.selected) || rest[0] || null;
  if (picked) {
    if (!picked.selected) ShotVideos.setSelected(sid, picked.id);
    Shots.update(sid, { video_path: picked.video_path, status: 'done', error: '' });
  } else {
    Shots.update(sid, { video_path: '', status: 'pending', error: '' });
  }
  return NextResponse.json(ShotVideos.listByShot(sid));
}
