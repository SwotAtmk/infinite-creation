// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { Projects, Jobs, loadConfig, interruptTask, projectDir, withWriteContext, pickProjectFields } from '@/lib/core/index.js';
import { stopJob, holdsRenderSlot } from '@/lib/agent/index.js';

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
      // 项目级分辨率 / 宽高比枚举、自定义宽高区间（分镜会继承它出片）：底层抛错，这里翻成 400
      if (e && e.code === 'BAD_PROJECT_ENUM') return NextResponse.json({ error: e.message }, { status: 400 });
      if (e && e.code === 'BAD_PROJECT_DIM') return NextResponse.json({ error: e.message }, { status: 400 });
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
  // 先停掉本项目正在跑/排队中的任务，再删：
  // 任务行会随 Projects.remove 一起删掉，而**进程里那条任务不会停**（停止注册表按 jobId 在内存里），
  // 它会继续出图/出片，并把 chapters/shots/assets 行重新插回一个「已经不存在的项目」—— 界面上
  // 再也看不到、也停不掉（项目页与任务列表都没了），只剩占显存与孤儿行，还会重建项目目录。
  // 与 /stop、/cancel、删除单个任务同一口径：活动任务先取消（停标记 + 立即出队；执行中的再主动
  // 打断一次 ComfyUI，让「停止」立刻生效、马上释放显存，而不是等 generate 轮询到下一拍）。
  // 但只有本项目确实有任务占着渲染槽位时才打断：行内任务（llm 参考图分析 / export 按章导出）
  // 不占 ComfyUI，而 /interrupt 是全局的——无脑打断会误杀**另一个项目**正在跑的渲染任务。
  const active = Jobs.list(id).filter((j) => j.status === 'running' || j.status === 'queued');
  for (const j of active) stopJob(j.id);
  if (active.some((j) => holdsRenderSlot(j.id))) {
    try { await interruptTask(loadConfig()); } catch {}
  }
  Projects.remove(id);
  try { fs.rmSync(projectDir(id), { recursive: true, force: true }); } catch {}
  return NextResponse.json({ ok: true, stopped: active.map((j) => j.id) });
}
