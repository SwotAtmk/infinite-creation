import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  ChevronDown,
  FileJson,
  Layers,
  Play,
  RefreshCw,
  Save,
  Workflow,
  Wrench,
} from 'lucide-react';
import { api } from '../lib/api.js';
import CostButton from '../components/CostButton.jsx';
import { STAGE_META } from '../components/ProgressPanel.jsx';
import { Badge, Button, EmptyState, Progress, Segmented, Select, Spinner, Textarea } from '../components/ui.jsx';
import { BusyOverlay, Modal } from '../components/overlays.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useToast } from '../components/toast.jsx';

const KIND_LABEL = { t2i: '文生图', i2i: '图生图', r2v: '视频', tts: '音色', music: '音乐', custom: '自定义' };
const KIND_OPTIONS = [
  { value: '', label: '全部' },
  { value: 't2i', label: '文生图' },
  { value: 'i2i', label: '图生图' },
  { value: 'r2v', label: '视频' },
  { value: 'tts', label: '音色' },
  { value: 'music', label: '音乐' },
];

export default function WorkflowPage({ projectId, chapters = [], progress, running, readOnly = false, canGenerate = true, features = {}, onRefresh, onGoLogs }) {
  const toast = useToast();
  const [workflows, setWorkflows] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [kind, setKind] = useState('');
  const [scope, setScope] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    Promise.all([
      api.get('/api/workflows').then(setWorkflows).catch(() => {}),
      api.get('/api/config').then(setCfg).catch(() => {}),
    ]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);


  const provider = cfg?.comfyui?.provider || 'native';
  const isRunningHub = provider === 'runninghub';
  const currentMap = cfg?.workflows || {};
  const activeJobs = progress?.activeJobs || [];
  const busyStage = running || activeJobs.length > 0;

  const shown = useMemo(() => {
    let list = workflows;
    if (kind) list = list.filter((w) => w.kind === kind);
    if (isRunningHub) {
      // 云端优先展示 RunningHub 工作流，本地备用收到后面
      list = [...list].sort((a, b) => Number(b.spec?.id?.startsWith('runninghub_')) - Number(a.spec?.id?.startsWith('runninghub_')));
    }
    return list;
  }, [workflows, kind, isRunningHub]);

  function isCurrent(w) {
    // RunningHub 模式下实际使用的是固定的云端 API 工作流（runninghub_*），
    // config.workflows 里可能仍是本地预设，不能拿来判断「当前使用」。
    if (isRunningHub) return String(w.spec?.id || '').startsWith('runninghub_');
    const id = currentMap?.[w.kind];
    return id === w.spec?.id;
  }

  async function openDetail(w) {
    setDetail({ ...w, loading: true });
    setJsonOpen(false);
    setJsonText('');
    setDetailLoading(true);
    try {
      const d = await api.get('/api/workflows/' + encodeURIComponent(w.id));
      setDetail(d);
      setJsonText(d.structure ? JSON.stringify(d.structure, null, 2) : '');
    } catch (e) {
      toast.error(e.message);
      setDetail(w);
    } finally {
      setDetailLoading(false);
    }
  }

  async function saveWorkflow() {
    if (!detail?.editable) return;
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      toast.error('JSON 解析失败：' + e.message);
      return;
    }
    if (!(await toast.confirm('保存后对「下一次提交」生效。正在云端执行中的任务无法热改，需要先取消再重新提交。确定保存？'))) return;
    setSaving(true);
    try {
      const r = await api.put('/api/workflows/' + encodeURIComponent(detail.id), { structure: parsed });
      setDetail((d) => ({ ...d, summary: r.summary, sourceError: '' }));
      toast.success('已保存工作流：' + detail.sourceFile);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

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
        description="每个阶段可以单独运行、单独看结果；工作流结构随点随看，修改对下一次提交生效，不必等整条流水线跑完。"
        actions={
          <Button variant="secondary" size="md" onClick={load}>
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

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Workflow size={14} className="text-[var(--fg-3)]" />
            <h3 className="m-0 text-[13px] font-semibold text-[var(--fg-2)]">工作流结构</h3>
            <Badge tone={isRunningHub ? 'info' : 'neutral'}>{isRunningHub ? '云端渲染' : '本地 ComfyUI'}</Badge>
          </div>
          <Segmented value={kind} onChange={setKind} options={KIND_OPTIONS} />
        </div>

        {shown.length ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {shown.map((w) => {
              const current = isCurrent(w);
              const cloud = String(w.spec?.id || '').startsWith('runninghub_');
              return (
                <article key={w.id} className={clsx('panel panel-hover flex flex-col gap-2.5 p-3.5', current && 'border-[color-mix(in_srgb,var(--accent)_45%,transparent)]')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-medium text-[var(--fg)]">{w.name}</span>
                        <Badge tone="neutral">{KIND_LABEL[w.kind] || w.kind}</Badge>
                        {cloud ? <Badge tone="info">云端</Badge> : null}
                        {current ? <Badge tone="accent">当前使用</Badge> : null}
                      </div>
                      <p className="m-0 mt-1 truncate font-mono text-[10px] text-[var(--fg-4)]" title={w.sourceFile}>
                        {w.sourceFile}
                      </p>
                    </div>
                    <Button variant="secondary" size="sm" className="shrink-0" onClick={() => openDetail(w)}>
                      <FileJson size={12} /> 结构
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-[var(--fg-3)]">
                    <span>节点角色 {Object.keys(w.spec?.roles || {}).length}</span>
                    <span>输出 {Array.isArray(w.spec?.outputs) ? w.spec.outputs.join(' / ') : '—'}</span>
                    {w.spec?.media ? <span>参考媒体 图{w.spec.media.maxImages} · 音视频{w.spec.media.maxAudioVideo}</span> : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="panel">
            <EmptyState icon={Workflow} title="暂无工作流" description="检查 workflows/ 目录并在设置页重新扫描。" />
          </div>
        )}
      </section>

      <Modal
        open={!!detail}
        onOpenChange={(o) => !o && setDetail(null)}
        title={detail?.name || '工作流结构'}
        description={detail ? (KIND_LABEL[detail.kind] || detail.kind) + ' · ' + detail.sourceFile : ''}
        size="2xl"
        footer={
          detail?.editable && !readOnly ? (
            <>
              <span className="mr-auto text-[10.5px] text-[var(--fg-4)]">保存后对下一次提交生效</span>
              <Button variant="ghost" size="md" onClick={() => setDetail(null)}>
                关闭
              </Button>
              <Button variant="primary" size="md" loading={saving} disabled={!jsonOpen} onClick={saveWorkflow}>
                <Save size={13} /> 保存 JSON
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="md" onClick={() => setDetail(null)}>
              关闭
            </Button>
          )
        }
      >
        {detailLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-[var(--fg-3)]">
            <Spinner size={15} /> 加载工作流结构…
          </div>
        ) : detail?.sourceError ? (
          <p className="m-0 text-[12px] text-[var(--danger)]">读取失败：{detail.sourceError}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-[var(--line)] bg-white/[0.015] p-3">
                <p className="m-0 mb-2 text-[10px] uppercase tracking-[.14em] text-[var(--fg-4)]">语义角色（应用会覆盖这些输入）</p>
                <div className="flex flex-col gap-1">
                  {Object.entries(detail?.spec?.roles || {}).map(([key, r]) => (
                    <div key={key} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-[var(--fg-3)]">{key}</span>
                      <span className="truncate font-mono text-[10px] text-[var(--fg-2)]" title={r.node + ' · ' + r.field}>
                        节点 {r.node} · {r.field}
                      </span>
                    </div>
                  ))}
                  {!Object.keys(detail?.spec?.roles || {}).length ? <span className="text-[11px] text-[var(--fg-4)]">无</span> : null}
                </div>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-white/[0.015] p-3">
                <p className="m-0 mb-2 text-[10px] uppercase tracking-[.14em] text-[var(--fg-4)]">节点概览</p>
                <div className="flex flex-col gap-1 text-[11px] text-[var(--fg-3)]">
                  <span>节点数：<b className="text-[var(--fg-2)]">{detail?.summary?.nodeCount ?? '—'}</b></span>
                  <span>参考媒体：{detail?.spec?.media ? '最多 图 ' + detail.spec.media.maxImages + ' / 音视频 ' + detail.spec.media.maxAudioVideo : '无'}</span>
                  <span>输出：{Array.isArray(detail?.spec?.outputs) ? detail.spec.outputs.join(' / ') : '—'}</span>
                  <span>模式：{detail?.editable ? '管理员可编辑' : '公开模式 · 只读'}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-[var(--fg-2)]">节点列表</span>
                <span className="text-[10.5px] text-[var(--fg-4)]">共 {detail?.summary?.nodeCount || 0} 个</span>
              </div>
              <div className="max-h-[260px] overflow-auto rounded-xl border border-[var(--line)]">
                <table className="w-full border-collapse text-[11px]">
                  <thead className="sticky top-0 bg-[var(--panel-2)] text-[10px] text-[var(--fg-4)]">
                    <tr>
                      <th className="px-2.5 py-1.5 text-left font-medium">ID</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">class_type</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">标题</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">输入</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail?.summary?.nodes || []).map((n) => (
                      <tr key={n.id} className="border-t border-[var(--line)]">
                        <td className="px-2.5 py-1.5 font-mono text-[10px] text-[var(--fg-3)]">{n.id}</td>
                        <td className="px-2.5 py-1.5 font-mono text-[10px] text-[var(--fg-2)]">{n.classType}</td>
                        <td className="px-2.5 py-1.5 text-[var(--fg-3)]">{n.title || '—'}</td>
                        <td className="max-w-[320px] truncate px-2.5 py-1.5 font-mono text-[10px] text-[var(--fg-4)]" title={n.inputs.join(', ')}>
                          {n.inputs.join(', ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setJsonOpen((v) => !v)}
                className="flex items-center justify-between rounded-xl border border-[var(--line)] bg-white/[0.015] px-3 py-2 text-[11px] text-[var(--fg-3)] hover:text-[var(--fg-2)]"
              >
                <span className="flex items-center gap-1.5">
                  <Wrench size={12} />
                  节点 JSON（{detail?.editable ? '可编辑' : '只读'}）
                </span>
                <ChevronDown size={13} className={jsonOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
              </button>
              {jsonOpen ? (
                <Textarea
                  rows={18}
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  readOnly={!detail?.editable}
                  className="font-mono text-[10.5px] leading-relaxed"
                  spellCheck={false}
                />
              ) : null}
            </div>
          </div>
        )}
      </Modal>

      <BusyOverlay show={!!busy} text={busy} />
    </div>
  );
}
