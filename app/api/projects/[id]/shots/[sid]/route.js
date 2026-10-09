// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Shots } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const ID_FIELDS = ['character_ids', 'scene_ids', 'prop_ids', 'costume_ids'];

export async function PATCH(req, { params }) {
  const { id, sid } = await params;
  const body = await req.json().catch(() => ({}));
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
  const patch = {};
  for (const k of ID_FIELDS) {
    if (Array.isArray(body[k])) patch[k] = body[k];
  }
  if (!Object.keys(patch).length) return NextResponse.json({ error: '无可更新字段' }, { status: 400 });
  return NextResponse.json(Shots.update(sid, patch));
}
