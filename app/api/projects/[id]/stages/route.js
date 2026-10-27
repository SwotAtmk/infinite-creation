// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, getAccount, loadConfig, walletEnabled } from '@/lib/core/index.js';
import { STAGES, pendingByStage, preflight, startStageJob, activeJobOf, activeJobOfChapter, validateStageDependencies, estimateProjectCost } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

// 勾选前的状态：各阶段待办数。不再返回「整条流水线停用原因」——应用不替用户判断服务能不能同时跑。
export async function GET(_req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return NextResponse.json({ stages: STAGES, pending: pendingByStage(id) });
}

// 起一批阶段任务。拦截逻辑放在 preflight，失败要回 400 并带上原因——
// 前端 alert 出来，别让人白等 3 分钟才发现 LLM 没启动。
export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });

  // 同一批勾选多个阶段时按固定依赖顺序执行（llm → image → tts → video），
  // 避免请求体顺序把「视频」排在「资产图」前面导致必失败。
  const order = new Map(STAGES.map((s, i) => [s.id, i]));
  const stages = [...new Set(Array.isArray(body?.stages) ? body.stages : [])].sort(
    (a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99),
  );
  const chapter = body?.chapter || '';
  // 同一章已有任务：直接返回原任务（不重复提交、不重复扣费）；其他章节不受影响。
  if (chapter) {
    const active = activeJobOfChapter(id, chapter);
    if (active) return NextResponse.json({ job: active, deduped: true });
  }
  const cfg = loadConfig();
  if (walletEnabled(cfg) && cfg.billing?.wallet?.requireFullEstimate === true) {
    const ownerId = Projects.ownerOf(id) || '';
    const account = getAccount(ownerId, cfg);
    const est = estimateProjectCost(id, chapter, cfg);
    if (est.total > account.available + 1e-9) {
      return NextResponse.json({ error: '余额不足以覆盖预计费用：需要 ' + est.total + '，可用 ' + account.available + '（后台可关闭「预算不足禁止开始」改为部分执行）', code: 'INSUFFICIENT_CREDITS' }, { status: 402 });
    }
  }
  let marked = false;
  try {
    // 先校验阶段依赖（分镜/资产图），再做服务就绪检查：前置产物缺失时直接给可读原因
    validateStageDependencies(id, stages, chapter);
    const info = await preflight(stages);
    // 未指定章节 = 针对全部章节，仍走项目级闸门；指定章节时只挡同一章。
    if (chapter ? activeJobOfChapter(id, chapter) : activeJobOf(id)) {
      return NextResponse.json({ error: '该章节已有运行中的任务' }, { status: 409 });
    }
    // 前端「运行中」判定读的是 project.status（ProjectView.jsx:42），与 /run 同一套做法
    Projects.update(id, { status: 'running' });
    marked = true;
    const job = startStageJob({ projectId: id, stages, chapter, onProgress: (patch) => broadcast(patch) });
    return NextResponse.json({ job, ...info });
  } catch (e) {
    // 任务实际没起来（startStageJob 抛错）时复位刚设上的运行态，与 /run 写法对齐，
    // 别留下一个永远「运行中」的项目；preflight 抛错时（还没置 running）不动项目态。
    if (marked) Projects.update(id, { status: 'idle' });
    if (e && e.code === 'INSUFFICIENT_CREDITS') return NextResponse.json({ error: e.message, code: e.code }, { status: 402 });
      return NextResponse.json({ error: e.message }, { status: 400 });
  }
}