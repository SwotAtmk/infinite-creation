import { useState } from 'react';
import {
  Layers,
  Play,
  RefreshCw,
} from 'lucide-react';
import { api } from '../lib/api.js';
import CostButton from '../components/CostButton.jsx';
import { STAGE_META } from '../components/ProgressPanel.jsx';
import { Badge, Button, Progress, Select } from '../components/ui.jsx';
import { BusyOverlay } from '../components/overlays.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useToast } from '../components/toast.jsx';

export default function WorkflowPage({ projectId, chapters = [], progress, running, readOnly = false, canGenerate = true, features = {}, onRefresh, onGoLogs }) {
  const toast = useToast();
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(null);

  const activeJobs = progress?.activeJobs || [];
  const busyStage = running || activeJobs.length > 0;

  async function runStage(stageId) {
    setBusy('正在提交「' + (STAGE_META.find((s) => s.id === stageId)?.label || stageId) + '」阶段…');
    try {
      const r = await api.post('/api/projects/' + projectId + '/stages', { stages: [stageId], chapter: scope });
      if (r.warns && r.warns.length) toast.warn(r.warns.join('\n'));
      toast.open({
        kind: 'info',
        message: '已提交阶段：' + (STAGE_META.find((s) => s.id === stageId)?.label || stageId) + '（进度会实时刷新）',
        buttons: onGoLogs ? [{ label: '前往运行日志', tone: 'primary', onClick: onGoLogs }] : [],
      });
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Pipeline"
        title="流程与工作流"
        description="每个阶段可以单独运行、单独看结果，不必等整条流水线跑完。"
        actions={
          <Button variant="secondary" size="md" onClick={onRefresh}>
            <RefreshCw size={13} /> 刷新
          </Button>
        }
      />

      <section className="panel flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers size={14} className="text-[var(--fg-3)]" />
            <h3 className="m-0 text-[13px] font-semibold text-[var(--fg-2)]">分阶段执行</h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--fg-3)]">范围</span>
            <div className="w-[200px]">
              <Select
                value={scope}
                onChange={setScope}
                size="sm"
                items={[{ value: '', label: '全部章节' }, ...chapters.map((c) => ({ value: c.title, label: c.title }))]}
              />
            </div>
          </div>
        </div>


        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {STAGE_META.map((meta) => {
            const s = progress?.stages?.[meta.id] || { total: 0, done: 0, todo: 0, percent: 0 };
            const Icon = meta.icon;
            const complete = s.total > 0 && s.percent >= 100;
            // 阶段依赖：没有前置产物就不允许点后面的阶段（后端也会再校验一次）
            const blocked =
              meta.id === 'image' && s.total === 0
                ? '还没有需要出图的资产：先创建角色 / 场景 / 道具'
                : meta.id === 'tts' && s.total === 0
                  ? '还没有角色资产，无法设计音色'
                  : meta.id === 'video'
                    ? s.total === 0
                      ? '还没有分镜：先运行「LLM 创作」生成分镜'
                      : (progress?.stages?.image?.todo || 0) > 0
                        ? '还有 ' + progress.stages.image.todo + ' 个资产未出图：先运行「资产图」'
                        : ''
                    : '';
            return (
              <div key={meta.id} className="flex flex-col gap-2 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[12px] text-[var(--fg-2)]">
                    <Icon size={13} className={complete ? 'text-[var(--success)]' : 'text-[var(--fg-3)]'} />
                    {meta.label}
                  </span>
                  <Badge tone={complete ? 'success' : s.todo ? 'accent' : s.total ? 'success' : 'neutral'}>
                    {complete ? '完成' : s.todo ? '待办 ' + s.todo : s.total ? '完成' : '未开始'}
                  </Badge>
                </div>
                <Progress value={s.percent} height={3} tone={complete ? 'success' : 'accent'} />
                <div className="flex items-center justify-between gap-2 text-[10.5px] text-[var(--fg-4)]">
                  <span>{s.done}/{s.total} · {meta.hint}</span>
                  <span className="font-mono">{s.percent}%</span>
                </div>
                {s.todo > 0 && s.items?.length ? (
                  <p className="m-0 line-clamp-2 text-[10px] leading-relaxed text-[var(--fg-4)]" title={s.items.join('\n')}>
                    缺：{s.items.slice(0, 3).join('；')}{s.todo > 3 ? ' 等 ' + s.todo + ' 项' : ''}
                  </p>
                ) : null}
                {readOnly || !canGenerate || features.buttons?.generate === false ? null : blocked ? (
                  <>
                    <Button variant="secondary" size="sm" className="mt-0.5 w-full" disabled title={blocked}>
                      <Play size={12} /> 运行此阶段
                    </Button>
                    <p className="m-0 text-[10px] leading-relaxed text-[var(--fg-4)]">{blocked}</p>
                  </>
                ) : (
                  <CostButton
                    variant="secondary"
                    size="sm"
                    className="mt-0.5 w-full"
                    disabled={busyStage}
                    onClick={() => runStage(meta.id)}
                  >
                    <Play size={12} /> 运行此阶段
                  </CostButton>
                )}
              </div>
            );
          })}
        </div>
        <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
          想先检查资产图？只勾「资产图」跑完即可回素材库/分镜页复核，再运行视频阶段；无需等全部结果。
          运行中的云端任务不能修改参数，修改工作流后请取消旧任务再重新提交。
        </p>
      </section>

      <BusyOverlay show={!!busy} text={busy} />
    </div>
  );
}
