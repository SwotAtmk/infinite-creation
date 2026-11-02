// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 无限・秩影记录：批量删除（跳过生成中的记录）。
import { NextResponse } from 'next/server';
import { Assets, Jobs, withWriteContext } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (!ids.length) return NextResponse.json({ error: 'ids 不能为空' }, { status: 400 });

  const deleted = [];
  const skipped = [];
  return withWriteContext('POST /api/projects/:id/opuscar/batch-delete', async () => {
    for (const aid of ids) {
      const a = Assets.get(aid);
      if (!a || a.project_id !== id || a.category !== 'video') {
        skipped.push({ id: aid, reason: '不存在或不属于本项目' });
        continue;
      }
      const active = Jobs.list(id).find(
        (j) => j.type === 'opuscar' && (j.status === 'running' || j.status === 'queued') && (j.checkpoint || {}).subject === aid,
      );
      if (active) {
        skipped.push({ id: aid, reason: '生成中' });
        continue;
      }
      Assets.remove(aid);
      deleted.push(aid);
    }
    return NextResponse.json({ deleted, skipped });
  });
}
