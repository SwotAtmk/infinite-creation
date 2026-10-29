// 简单工作台共享逻辑：用户不感知项目，自动复用/创建该类型的隐藏项目，
// 并轮询资产与任务，把生成结果以统一卡片展示。
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Download, FileAudio, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { fileUrl, STATUS_TEXT } from '../lib/format.js';
import { Button, EmptyState, Spinner, StatusPill } from './ui.jsx';
import { Modal } from './overlays.jsx';
import { useToast } from './toast.jsx';

const ACTIVE = new Set(['running', 'queued']);

export function useAutoProject(type, defaultName) {
  const [projectId, setProjectId] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get('/api/projects?type=' + type + '&pageSize=1');
        const first = (r.items || [])[0];
        if (cancelled) return;
        if (first) {
          setProjectId(first.id);
          return;
        }
        const p = await api.post('/api/projects', { name: defaultName + '-1', type });
        if (!cancelled) setProjectId(p.id);
      } catch {
        // 忽略：生成时若仍未就绪会给出提示
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [type, defaultName]);
  return projectId;
}

export function useAssets(projectId, category) {
  const [assets, setAssets] = useState([]);
  const load = useCallback(() => {
    if (!projectId) {
      setAssets([]);
      return Promise.resolve();
    }
    return api
      .get('/api/projects/' + projectId + '/assets?category=' + category)
      .then((a) => setAssets(Array.isArray(a) ? a : []))
      .catch(() => setAssets([]));
  }, [projectId, category]);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  return { assets, reload: load };
}

export function useJobs(projectId) {
  const [jobs, setJobs] = useState([]);
  const load = useCallback(() => {
    if (!projectId) {
      setJobs([]);
      return Promise.resolve();
    }
    return api
      .get('/api/projects/' + projectId + '/jobs')
      .then((j) => setJobs(Array.isArray(j) ? j : []))
      .catch(() => setJobs([]));
  }, [projectId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  return { jobs, reloadJobs: load };
}

export function activeJobForAsset(jobs, assetId) {
  return (jobs || []).find((j) => ACTIVE.has(j.status) && j.checkpoint && j.checkpoint.subject === assetId) || null;
}

export function FilePill({ children, onRemove }) {
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[var(--line)] bg-white/[0.03] pl-2.5 pr-1 text-[11.5px] text-[var(--fg-2)]">
      <span className="truncate">{children}</span>
      <button
        type="button"
        aria-label="移除"
        onClick={onRemove}
        className="rounded-full p-0.5 text-[var(--fg-3)] transition-colors hover:bg-white/[0.08] hover:text-[var(--fg)]"
      >
        <X size={11} />
      </button>
    </span>
  );
}

export function MediaCard({ projectId, asset, kind, activeJobId, onRetry, onChanged }) {
  const toast = useToast();
  const [detailOpen, setDetailOpen] = useState(false);
  const [busy, setBusy] = useState('');

  const path = kind === 'image' ? asset.image_path : kind === 'video' ? asset.video_path : asset.audio_path || asset.voice_ref;
  const url = path ? fileUrl(projectId, path) : '';
  const status = asset.status;
  const generating = status === 'generating' || status === 'running' || (status === 'pending' && !!activeJobId);
  const hasRetryInput = !!(asset.prompt || (asset.params && Object.keys(asset.params).length));
  const canRetry = !!onRetry && !generating && hasRetryInput;

  async function stopJob() {
    if (!activeJobId) return;
    setBusy('stop');
    try {
      await api.post('/api/projects/' + projectId + '/jobs/' + activeJobId + '/cancel');
      toast.success('已停止任务');
      onChanged && onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    if (!(await toast.confirm('删除「' + asset.name + '」？删除后不可恢复。', { danger: true }))) return;
    setBusy('del');
    try {
      await api.del('/api/projects/' + projectId + '/assets/' + asset.id);
      toast.success('已删除');
      onChanged && onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  }

  async function retry() {
    setBusy('retry');
    try {
      await onRetry(asset);
      onChanged && onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <article className="panel flex flex-col overflow-hidden">
      <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-black/35">
        {generating ? (
          <div className="flex flex-col items-center gap-2 text-[var(--fg-3)]">
            <Spinner size={16} />
            <span className="text-[11px]">生成中…</span>
          </div>
        ) : url ? (
          kind === 'image' ? (
            <img src={url} alt={asset.name} loading="lazy" className="h-full w-full object-contain" />
          ) : kind === 'video' ? (
            <video src={url} controls preload="metadata" className="h-full w-full bg-black object-contain" />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3">
              <FileAudio size={18} className="text-[var(--fg-3)]" />
              <audio src={url} controls preload="metadata" className="h-8 w-full" />
            </div>
          )
        ) : (
          <span className="text-[11.5px] text-[var(--fg-4)]">{status === 'failed' ? '生成失败' : '暂无产物'}</span>
        )}
        <div className="absolute left-2.5 top-2.5">
          <StatusPill status={status}>{STATUS_TEXT[status] || status || '排队中'}</StatusPill>
        </div>
      </div>

      <div className="flex flex-col gap-2 p-3">
        <span className="truncate text-[13px] font-medium text-[var(--fg)]" title={asset.name}>
          {asset.name}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="secondary" size="xs" onClick={() => setDetailOpen(true)}>
            详情
          </Button>
          {generating && activeJobId ? (
            <Button variant="secondary" size="xs" disabled={!!busy} onClick={stopJob}>
              <Square size={10} /> {busy === 'stop' ? '停止中…' : '停止'}
            </Button>
          ) : null}
          {canRetry ? (
            <Button variant="secondary" size="xs" disabled={!!busy} onClick={retry}>
              <RefreshCw size={10} /> {busy === 'retry' ? '提交中…' : '重试'}
            </Button>
          ) : null}
          {url && status === 'done' ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              download
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-white/[0.04] px-2.5 text-[12px] font-medium text-[var(--fg)] transition-colors hover:border-[var(--line-strong)] hover:bg-white/[0.07]"
            >
              <Download size={11} /> 下载
            </a>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            className={clsx('ml-auto', !activeJobId && 'text-[var(--fg-3)] hover:text-[var(--danger)]')}
            disabled={!!busy || !!activeJobId}
            onClick={remove}
          >
            <Trash2 size={11} />
          </Button>
        </div>
      </div>

      <Modal
        open={detailOpen}
        onOpenChange={setDetailOpen}
        title="结果详情"
        description={asset.name}
        size="lg"
        footer={
          <Button variant="secondary" size="md" onClick={() => setDetailOpen(false)}>
            关闭
          </Button>
        }
      >
        <div className="flex flex-col gap-3 text-[12px] leading-relaxed text-[var(--fg-2)]">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={status}>{STATUS_TEXT[status] || status || '排队中'}</StatusPill>
            <span className="text-[11px] text-[var(--fg-3)]">{asset.category}</span>
          </div>
          <div>
            <span className="text-[var(--fg-4)]">提示词</span>
            <div className="logbox mt-1 max-h-[150px]">{asset.prompt || '（无）'}</div>
          </div>
          <div>
            <span className="text-[var(--fg-4)]">生成参数</span>
            <div className="logbox mt-1 max-h-[190px] text-[11px]">{JSON.stringify(asset.params || {}, null, 2)}</div>
          </div>
          {path ? (
            <div className="text-[11px] text-[var(--fg-3)]">
              文件：<span className="break-all">{path}</span>
            </div>
          ) : null}
        </div>
      </Modal>
    </article>
  );
}

export function MediaGrid({ projectId, assets, kind, jobs, onRetry, onChanged, icon: Icon, emptyTitle = '暂无生成结果', emptyDescription }) {
  if (!assets.length) {
    return (
      <div className="panel">
        <EmptyState icon={Icon} title={emptyTitle} description={emptyDescription} />
      </div>
    );
  }
  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
      {assets.map((a) => {
        const job = activeJobForAsset(jobs, a.id);
        return (
          <MediaCard
            key={a.id}
            projectId={projectId}
            asset={a}
            kind={kind}
            activeJobId={job ? job.id : ''}
            onRetry={onRetry}
            onChanged={onChanged}
          />
        );
      })}
    </div>
  );
}
