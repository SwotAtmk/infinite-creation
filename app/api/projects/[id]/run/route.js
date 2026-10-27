// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, Projects, getAccount, loadConfig, walletEnabled } from '@/lib/core/index.js';
import { startCreateJob, startCreateAllJobs, activeJobOfChapter, estimateProjectCost } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const chapter = body?.chapter ? String(body.chapter) : '';
  const onProgress = (patch) => broadcast(patch);

  const cfg = loadConfig();
  const needFull = walletEnabled(cfg) && cfg.billing?.wallet?.requireFullEstimate === true;
  const ownerId = Projects.ownerOf(id) || '';
  const account = needFull ? getAccount(ownerId, cfg) : null;

  // 单章：同一章已有任务就返回原任务，不再重复建（防重复点击/重复扣 LLM）；
  // 其他章节不受影响，可以并行跑。
  if (chapter) {
    const active = activeJobOfChapter(id, chapter);
    if (active) return NextResponse.json([{ ...active, deduped: true }]);
    if (needFull) {
      const est = estimateProjectCost(id, chapter, cfg);
      if (est.total > account.available + 1e-9) {
        return NextResponse.json({ error: '余额不足以覆盖本章预计费用：需要 ' + est.total + '，可用 ' + account.available + '（后台可关闭「预算不足禁止开始」改为部分执行）', code: 'INSUFFICIENT_CREDITS' }, { status: 402 });
      }
    }
    Projects.update(id, { status: 'running' });
    try {
      return NextResponse.json([startCreateJob({ projectId: id, chapter, onProgress })]);
    } catch (e) {
      Projects.update(id, { status: 'idle' });
      if (e && e.code === 'INSUFFICIENT_CREDITS') return NextResponse.json({ error: e.message, code: e.code }, { status: 402 });
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  }

  // 全部章节：跳过已经在跑的章节，只启动剩下的；全部都在跑时才拒绝。
  const chapters = Chapters.list(id);
  if (!chapters.length) return NextResponse.json({ error: '项目还没有章节' }, { status: 400 });
  const targets = chapters.filter((c) => !activeJobOfChapter(id, c.title));
  if (!targets.length) return NextResponse.json({ error: '所有章节都已有任务在运行' }, { status: 409 });
  if (needFull) {
    const est = estimateProjectCost(id, '', cfg);
    if (est.total > account.available + 1e-9) {
      return NextResponse.json({ error: '余额不足以覆盖整章预计费用：需要 ' + est.total + '，可用 ' + account.available + '（后台可关闭「预算不足禁止开始」改为部分执行）', code: 'INSUFFICIENT_CREDITS' }, { status: 402 });
    }
  }
  Projects.update(id, { status: 'running' });
  try {
    const jobs = startCreateAllJobs({ projectId: id, chapters: targets.map((c) => c.title), onProgress });
    return NextResponse.json(jobs);
  } catch (e) {
    // 起任务失败（如项目已被删）：复位项目运行态再回 400，而不是留下一个永远「运行中」的项目。
    Projects.update(id, { status: 'idle' });
    if (e && e.code === 'INSUFFICIENT_CREDITS') return NextResponse.json({ error: e.message, code: e.code }, { status: 402 });
      return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
