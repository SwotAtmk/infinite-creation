// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { Projects, projectDir, withWriteContext, pickProjectFields } from '@/lib/core/index.js';

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
  // 只接受内容字段（见 lib/core/shot-write.js 的 pickProjectFields）：status 是流水线状态
  // （前端「运行中」判定、/run、/stages 都读它），context 有专门的 PUT /context 路由
  // （同时落盘 context/*.md）——从 PATCH 进来会伪造状态，或让 DB 与盘上文件脱节。
  const { patch, errors } = pickProjectFields(body);
  if (errors.length) return NextResponse.json({ error: errors.join('；') }, { status: 400 });
  return withWriteContext('PATCH /api/projects/:id', async () => {
    try {
      const p = Projects.update(id, patch);
      if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
      return NextResponse.json(p);
    } catch (e) {
      // 项目级分辨率 / 宽高比枚举（分镜会继承它出片）：底层抛错，这里翻成 400
      if (e && e.code === 'BAD_PROJECT_ENUM') return NextResponse.json({ error: e.message }, { status: 400 });
      throw e;
    }
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
