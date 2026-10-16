// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, rollbackLogs } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

// 回滚变更日志。三种目标三选一：
//   { log_id }    回滚单条
//   { batch_id }  回滚整整一批（同一次 API / 工具调用）
//   { since_ts }  回滚该时刻（含）之后的所有变更
// force=true 时跳过漂移保护（覆盖该变更之后的新改动）。
export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  try {
    const result = rollbackLogs({
      projectId: id,
      logId: body?.log_id,
      batchId: body?.batch_id,
      sinceTs: body?.since_ts,
      force: !!body?.force,
    });
    // blocked=true：有变更在该日志之后被改过，未做任何回滚，交调用方决定是否 force
    return NextResponse.json(result, { status: result.blocked ? 409 : 200 });
  } catch (e) {
    const status = e && (e.code === 'NO_PROJECT_DELETE' || e.code === 'BAD_TARGET' || e.code === 'BAD_ENTITY') ? 400 : 500;
    // 逆操作整批跑在事务里：失败即整体回滚，这里如实回报「一条都没应用」，不给「改了一半」的假象
    return NextResponse.json({
      error: e.message,
      applied: [],
      ...(e && e.rolledBack ? { rolled_back: true, attempted: e.attempted || 0, failed_log_id: e.failedLogId || '' } : {}),
    }, { status });
  }
}
