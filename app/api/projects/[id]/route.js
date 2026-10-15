// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { Projects, projectDir, withWriteContext } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return NextResponse.json(p);
}

export async function PATCH(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  return withWriteContext('PATCH /api/projects/:id', async () => {
    const p = Projects.update(id, body || {});
    if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    return NextResponse.json(p);
  });
}

export async function DELETE(_req, { params }) {
  const { id } = await params;
  // 先确认项目确实存在再删目录：id 来自 URL，Next 的 route handler 会把 %2e%2e / %2f
  // 解码成 '..' / '/'（见 vercel/next.js#64952：route.ts 的 params 会被解码）。
  // 未校验就 rmSync(projectDir(id), {recursive:true}) 等于对任意目录做递归删除
  // —— projectDir 只是 path.join(PROJECTS_DIR, id)，本身不含边界校验。
  // 存在性检查同时保证 id 是库里的 uid（不含路径分隔符），从而 projectDir(id) 必落在项目目录内。
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  Projects.remove(id);
  try { fs.rmSync(projectDir(id), { recursive: true, force: true }); } catch {}
  return NextResponse.json({ ok: true });
}
