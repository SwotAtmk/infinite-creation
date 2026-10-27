import { Ban, ClipboardList, ListChecks, Trash2 } from 'lucide-react';
import { Drawer } from './overlays.jsx';
import { Badge, Button, EmptyState, Progress } from './ui.jsx';
import { JobTypeIcon } from './visuals.jsx';
import { jobStageLabel, jobStagePercent } from './ProgressPanel.jsx';
import { CANCELLABLE, JOB_LABEL, JOB_STATUS_META, fmtDuration, fmtRelative } from '../lib/format.js';

const KIND_LABEL = {
  t2i: '资产图', i2i: '资产图', image: '资产图',
  r2v: '分镜视频', i2v: '分镜视频', video: '分镜视频',
  tts: '音色', voice: '音色', music: '背景音乐', export: '合成/导出',
};

export default function TaskDrawer({
  open,
  onOpenChange,
  jobs,
  progress,
  queue,
  runningCount,
  queuedCount,
  finishedCount,
  shownJobs,
  readOnly = false,
  onStopAll,
  onClearFinished,
  onCancel,
  onRemove,
}) {
  // 每个任务在渲染队列里的排位（同一条流水线同时只会有一个等待中的渲染）
  // 管理员能拿到全局 items；普通用户只有自己的 mine。
  const queueItems = queue?.items?.length ? queue.items : (queue?.mine || []);
  const queueByJob = new Map();
  for (const it of queueItems) {
    if (!it.jobId) continue;
    const rank = (x) => (x.status === 'running' ? -1 : (x.position || Number.MAX_SAFE_INTEGER));
    const prev = queueByJob.get(it.jobId);
    if (!prev || rank(it) < rank(prev)) queueByJob.set(it.jobId, it);
  }
  const queueLabel = (it) => {
    const chapter = it.chapter || it.payload?.chapter || '';
    const subject = it.subject || it.payload?.subject || '';
    const parts = [chapter, subject].filter(Boolean);
    if (parts.length) return parts.join(' · ');
    return KIND_LABEL[it.kind] || it.kind || '渲染任务';
  };
  const queueKnown = !!queue?.enabled;
  const description = queueKnown
    ? (queue.running || 0) + '/' + queue.capacity + ' 个渲染槽在用' + (queue.waiting ? ' · ' + queue.waiting + ' 个渲染排队' : '')
    : runningCount || queuedCount
      ? runningCount + ' 个执行中' + (queuedCount ? ' · ' + queuedCount + ' 个排队中' : '')
      : finishedCount
        ? finishedCount + ' 条已结束记录'
        : '当前没有任务';
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="任务队列"
      description={description}
      width={470}
      bodyClassName="flex flex-col gap-3"
      footer={
        readOnly ? null : (
          <>
            {finishedCount > 0 ? (
              <Button variant="ghost" size="md" onClick={onClearFinished}>
                <ListChecks size={14} /> 清除已结束
              </Button>
            ) : null}
            {runningCount + queuedCount > 0 ? (
              <Button variant="danger" size="md" onClick={onStopAll}>
                <Ban size={14} /> 全部停止
              </Button>
            ) : null}
          </>
        )
      }
    >
      {progress ? (
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--fg-3)]">整体进度</span>
            <span className="font-mono text-[12px] text-[var(--accent)]">{progress.overall?.percent ?? 0}%</span>
          </div>
          <Progress value={progress.overall?.percent ?? 0} height={3} />
        </div>
      ) : null}

      {shownJobs.length === 0 ? (
        <EmptyState icon={ClipboardList} title="暂无任务" description="在章节页点击「生成」后，任务会实时出现在这里。" />
      ) : (
        shownJobs.map((j) => {
          const meta = JOB_STATUS_META[j.status] || { label: j.status, tone: 'neutral' };
          const isActive = j.status === 'running' || j.status === 'queued';
          const qi = queueByJob.get(j.id);
          const cp = j.checkpoint || {};
          const chapterLabel = cp.chapter || (Array.isArray(cp.stages) ? cp.stages.join('、') : '');
          const canCancel = isActive && CANCELLABLE.has(j.type) && !readOnly;
          const canRemove = !readOnly && !(j.status === 'running' && !CANCELLABLE.has(j.type));
          return (
            <div key={j.id} className="panel-flat flex flex-col gap-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={meta.tone} dot={isActive}>
                      {meta.label}
                    </Badge>
                    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--fg)]">
                      <JobTypeIcon type={j.type} size={13} className="text-[var(--fg-3)]" />
                      {JOB_LABEL[j.type] || j.type}
                    </span>
                  </div>
                  {(j.subjectLabel || chapterLabel) ? (
                    <p className="m-0 mt-1 truncate text-[11.5px] text-[var(--fg-3)]">{j.subjectLabel || chapterLabel}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {canCancel ? (
                    <Button variant="ghost" size="iconSm" aria-label="取消任务" title="取消任务" onClick={() => onCancel(j.id)}>
                      <Ban size={13} />
                    </Button>
                  ) : null}
                  {canRemove ? (
                    <Button variant="ghost" size="iconSm" aria-label="删除任务记录" title="删除任务记录" onClick={() => onRemove(j.id)}>
                      <Trash2 size={13} />
                    </Button>
                  ) : null}
                </div>
              </div>

              {qi ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-[rgba(232,177,92,.28)] bg-[rgba(232,177,92,.07)] px-2.5 py-1.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-[var(--accent)]">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)] animate-pulse-soft" />
                    <span className="truncate">
                      {qi.status === 'running' ? '正在渲染：' : '排队第 ' + (qi.position || '—') + ' 位 · '}
                      {queueLabel(qi)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10.5px] text-[var(--fg-3)]">
                    {qi.status === 'running' ? (KIND_LABEL[qi.kind] || qi.kind || '') : (qi.etaMs ? '预计 ' + fmtEta(qi.etaMs) : '等待空闲槽位')}
                  </span>
                </div>
              ) : isActive ? (
                (() => {
                  const pct = jobStagePercent(progress, j);
                  const label = jobStageLabel(progress, j);
                  return (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-white/[0.02] px-2.5 py-1.5">
                        <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-[var(--fg-2)]">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)] animate-pulse-soft" />
                          <span className="truncate">当前步骤：{j.phase || '准备中'}</span>
                        </span>
                        {j.detail ? (
                          <span className="max-w-[45%] shrink-0 truncate text-[10px] text-[var(--fg-4)]" title={j.detail}>{j.detail}</span>
                        ) : null}
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--fg-4)]">
                        <span className="truncate">{label}</span>
                        <span className="shrink-0 font-mono">{pct == null ? '进行中' : pct + '%'}</span>
                      </div>
                      {pct == null ? <div className="skeleton h-[3px] rounded-full" /> : <Progress value={pct} height={3} />}
                    </div>
                  );
                })()
              ) : null}

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-[var(--fg-4)]">
                <span>{fmtRelative(j.startedAt)}</span>
                {j.finishedAt ? <span>· 用时 {fmtDuration(j.startedAt, j.finishedAt)}</span> : null}
                {j.phase ? <span className="truncate">· {j.phase}</span> : null}
              </div>
              {j.detail ? <p className="m-0 line-clamp-2 text-[11px] leading-relaxed text-[var(--fg-3)]">{j.detail}</p> : null}
              {j.error ? (
                <p className="m-0 rounded-lg border border-[color-mix(in_srgb,var(--danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--danger)]">
                  {j.error}
                </p>
              ) : null}
            </div>
          );
        })
      )}
    </Drawer>
  );
}

// 预计等待：队列按池统计的平均耗时 × 前方任务数 / 槽位（服务端已算好 etaMs，这里只做展示格式化）
function fmtEta(ms) {
  const m = Math.ceil(Number(ms) / 60000);
  if (!Number.isFinite(m) || m <= 0) return '不到 1 分钟';
  if (m < 60) return '约 ' + m + ' 分钟';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return '约 ' + h + ' 小时' + (r ? ' ' + r + ' 分钟' : '');
}
