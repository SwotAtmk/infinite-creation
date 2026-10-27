import { Film, Image as ImageIcon, Mic2, Wand2 } from 'lucide-react';
import clsx from 'clsx';
import { Badge, Progress, Skeleton } from './ui.jsx';
import { JobTypeIcon } from './visuals.jsx';

export const STAGE_META = [
  { id: 'llm', label: 'LLM 创作', hint: '剧本 / 分镜 / 提示词', icon: Wand2 },
  { id: 'image', label: '资产图', hint: '角色 / 场景 / 道具', icon: ImageIcon },
  { id: 'tts', label: '音色', hint: '角色音色样本', icon: Mic2 },
  { id: 'video', label: '分镜视频', hint: '逐镜出片 + 合成', icon: Film },
];

// 根据任务类型/检查点，估算该任务对应的阶段进度（用于任务抽屉里的进度条）。
export function jobStagePercent(progress, job) {
  if (!progress) return null;
  if (job?.progress && Number(job.progress.total) > 0) {
    return Math.round((Number(job.progress.done || 0) / Number(job.progress.total)) * 100);
  }
  const chapter = job?.checkpoint?.chapter;
  if (chapter) {
    const item = progress.chapters?.items?.find((c) => c.title === chapter || c.id === chapter);
    if (item) return item.percent;
  }
  const type = job?.type || '';
  if (type === 'asset-image' || type === 'costume' || type === 'age') return progress.stages?.image?.percent ?? null;
  if (type === 'voice-design') return progress.stages?.tts?.percent ?? null;
  if (type === 'chapter-video' || type === 'music-apply' || type === 'music') return progress.stages?.video?.percent ?? null;
  if (type === 'stage') {
    const ids = job?.checkpoint?.stages;
    if (Array.isArray(ids) && ids.length) {
      const vals = ids.map((id) => progress.stages?.[id]?.percent).filter((n) => typeof n === 'number');
      if (vals.length) return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
  }
  return progress.overall?.percent ?? null;
}

export function jobStageLabel(progress, job) {
  const chapter = job?.checkpoint?.chapter;
  if (chapter) {
    const item = progress?.chapters?.items?.find((c) => c.title === chapter || c.id === chapter);
    if (item?.shots?.total) return chapter + ' · ' + item.shots.done + '/' + item.shots.total + ' 镜';
  }
  if (job?.subjectLabel) return job.subjectLabel;
  return job?.phase || '';
}

export default function ProgressPanel({ progress, activeJob, compact = false, className }) {
  if (!progress) {
    return (
      <div className={clsx('panel p-3.5', className)}>
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-24 rounded" />
            <Skeleton className="h-2 w-full rounded-full" />
          </div>
        </div>
      </div>
    );
  }

  const overall = progress.overall || { percent: 0, done: 0, total: 0 };
  const active = activeJob || progress.activeJobs?.[0];

  if (compact) {
    return (
      <div className={clsx('flex flex-col gap-2', className)}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--fg-3)]">整体进度</span>
          <span className="font-mono text-[12px] text-[var(--accent)]">{overall.percent}%</span>
        </div>
        <Progress value={overall.percent} height={4} />
        {active ? (
          <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--fg-4)]">
            <JobTypeIcon type={active.type} size={10} />
            <span className="truncate">{active.phase || active.type}</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className={clsx('panel flex flex-col gap-3 p-3.5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="section-label">流程进度</span>
          <Badge tone={progress.projectStatus === 'running' ? 'accent' : 'neutral'} dot={progress.projectStatus === 'running'}>
            {progress.projectStatus === 'running' ? '运行中' : '空闲'}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {active ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--fg-3)]">
              <JobTypeIcon type={active.type} size={11} />
              <span className="max-w-[320px] truncate">{active.phase || active.detail || active.type}</span>
            </span>
          ) : null}
          <span className="font-mono text-[13px] font-medium text-[var(--accent)]">{overall.percent}%</span>
        </div>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {STAGE_META.map((meta) => {
          const s = progress.stages?.[meta.id] || { total: 0, done: 0, todo: 0, percent: 0 };
          const Icon = meta.icon;
          const done = s.total > 0 && s.percent >= 100;
          return (
            <div key={meta.id} className="flex flex-col gap-1.5 rounded-xl border border-[var(--line)] bg-white/[0.015] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Icon size={12} className={done ? 'text-[var(--success)]' : 'text-[var(--fg-3)]'} />
                  <span className="truncate text-[11.5px] text-[var(--fg-2)]">{meta.label}</span>
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-[var(--fg-3)]">{s.percent}%</span>
              </div>
              <Progress value={s.percent} height={3} tone={done ? 'success' : 'accent'} />
              <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--fg-4)]">
                <span>
                  {s.done}/{s.total}
                  <span className="hidden sm:inline"> · {meta.hint}</span>
                </span>
                {s.todo > 0 ? (
                  <Badge tone="accent">待办 {s.todo}</Badge>
                ) : s.total > 0 ? (
                  <span className="text-[var(--success)]">完成</span>
                ) : (
                  <span>未开始</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
