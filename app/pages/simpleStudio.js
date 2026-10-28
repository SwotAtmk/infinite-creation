'use client';
// 简单模式页共享工具：自动管理「隐藏项目」+ 资产结果轮询展示。
// 用户不感知项目：每次进入自动复用该类型最近一个项目（没有则按序号新建，仅作标识）。
import { useState, useEffect, useCallback } from 'react';
import { Button, Chip, Spinner, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from '@heroui/react';
import { api } from '../api-client.js';
import { statusColor, fileUrl } from './shared';
import { useToast } from '../toast';

// 自动创建/复用该类型的「隐藏项目」，返回 projectId（'' 表示尚未就绪）。
export function useAutoProject(type, defaultName) {
  const [projectId, setProjectId] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get('/api/projects?type=' + type + '&pageSize=1');
        const first = (r.items || [])[0];
        if (cancelled) return;
        if (first) { setProjectId(first.id); return; }
        const p = await api.post('/api/projects', { name: defaultName + '-1', type });
        if (!cancelled) setProjectId(p.id);
      } catch { /* 忽略：未就绪时 generate 会提示 */ }
    })();
    return () => { cancelled = true; };
  }, [type, defaultName]);
  return projectId;
}

// 资产结果：按分类拉取，固定 4s 轮询（结果由后端异步推进）
export function useAssets(projectId, category) {
  const [assets, setAssets] = useState([]);
  const load = useCallback(() => {
    if (!projectId) { setAssets([]); return Promise.resolve(); }
    return api.get('/api/projects/' + projectId + '/assets?category=' + category)
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

// 任务列表：用来把「生成中的结果」关联到它对应的任务，从而支持「停止任务」。
// 任务靠 checkpoint.subject 记录目标资产 id（见 lib/agent/job-runner.js）。
export function useJobs(projectId) {
  const [jobs, setJobs] = useState([]);
  const load = useCallback(() => {
    if (!projectId) { setJobs([]); return Promise.resolve(); }
    return api.get('/api/projects/' + projectId + '/jobs')
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

const ACTIVE = new Set(['running', 'queued']);

// 某个资产当前的活动任务（排队中/执行中）
export function activeJobForAsset(jobs, assetId) {
  return (jobs || []).find((j) => ACTIVE.has(j.status) && j.checkpoint && j.checkpoint.subject === assetId) || null;
}

const STATUS_LABEL = { pending: '待生成', generating: '生成中', running: '生成中', done: '完成', failed: '失败' };

// 单个结果卡片：按媒体类型渲染 image/video/audio，含 详情/重试/停止/删除/下载
export function MediaCard({ projectId, asset, kind, activeJobId, onRetry, onChanged }) {
  const toast = useToast();
  const [detailOpen, setDetailOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState('');

  const path = kind === 'image' ? asset.image_path : kind === 'video' ? asset.video_path : asset.audio_path;
  const url = path ? fileUrl(projectId, path) : '';
  const status = asset.status;
  // pending 只是「建了行还没提交」：没有活动任务就不是真的在生成，否则卡片会永远转圈
  const generating = status === 'generating' || status === 'running' || (status === 'pending' && !!activeJobId);
  // 重试要能复现上次的输入：prompt 或 params 至少有一个，否则重试只会跑出无关内容
  const hasRetryInput = !!(asset.prompt || (asset.params && Object.keys(asset.params).length));
  const canRetry = !!onRetry && !generating && hasRetryInput;

  async function stopJob() {
    if (!activeJobId) return;
    setBusy('stop');
    try {
      await api.post('/api/projects/' + projectId + '/jobs/' + activeJobId + '/cancel');
      toast.success('已停止任务');
      onChanged && onChanged();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(''); }
  }

  async function remove() {
    setBusy('del');
    try {
      await api.del('/api/projects/' + projectId + '/assets/' + asset.id);
      toast.success('已删除');
      setConfirmOpen(false);
      onChanged && onChanged();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(''); }
  }

  async function retry() {
    setBusy('retry');
    try {
      await onRetry(asset);
      onChanged && onChanged();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(''); }
  }

  return (
    <div className="border rounded-xl overflow-hidden flex flex-col bg-default-50">
      <div className="relative aspect-video bg-black flex items-center justify-center">
        {generating ? (
          <div className="flex flex-col items-center gap-2 text-default-400">
            <Spinner size="sm" />
            <span className="text-xs">生成中…</span>
          </div>
        ) : url ? (
          kind === 'image' ? <img src={url} alt={asset.name} className="w-full h-full object-contain" />
            : kind === 'video' ? <video src={url} controls className="w-full h-full" />
            : <audio src={url} controls className="w-full" />
        ) : (
          <span className="text-default-500 text-sm">{status === 'failed' ? '生成失败' : '暂无产物'}</span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 p-2">
        <div className="min-w-0">
          <div className="text-sm truncate">{asset.name}</div>
          <Chip size="sm" variant="flat" color={statusColor(status)}>{STATUS_LABEL[status] || status || '排队中'}</Chip>
        </div>
        {url && status === 'done' && <a className="text-sm text-primary hover:underline shrink-0" href={url} target="_blank" rel="noreferrer">下载</a>}
      </div>
      <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
        <Button size="sm" variant="flat" onPress={() => setDetailOpen(true)}>详情</Button>
        {generating && activeJobId && (
          <Button size="sm" variant="flat" color="warning" isDisabled={!!busy} onPress={stopJob}>
            {busy === 'stop' ? '停止中…' : '停止'}
          </Button>
        )}
        {canRetry && (
          <Button size="sm" variant="flat" color="primary" isDisabled={!!busy} onPress={retry}>
            {busy === 'retry' ? '提交中…' : '重试'}
          </Button>
        )}
        <Button size="sm" variant="light" color="danger" isDisabled={!!busy || !!activeJobId} onPress={() => setConfirmOpen(true)}>
          删除
        </Button>
      </div>

      <Modal isOpen={detailOpen} backdrop="blur" onClose={() => setDetailOpen(false)}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="pb-2"><h2 className="m-0 text-lg font-semibold">结果详情</h2></ModalHeader>
              <ModalBody>
                <div className="flex flex-col gap-3 text-sm">
                  <div><b>名称：</b>{asset.name}</div>
                  <div><b>状态：</b>{STATUS_LABEL[status] || status || '排队中'}</div>
                  <div>
                    <b>提示词：</b>
                    <div className="logbox" style={{ whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>{asset.prompt || '（无）'}</div>
                  </div>
                  <div>
                    <b>生成参数：</b>
                    <div className="logbox" style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto', fontSize: 12 }}>
                      {JSON.stringify(asset.params || {}, null, 2)}
                    </div>
                  </div>
                  {path && <div><b>文件：</b><span style={{ wordBreak: 'break-all' }}>{path}</span></div>}
                </div>
              </ModalBody>
              <ModalFooter>
                <Button size="sm" variant="flat" onPress={() => setDetailOpen(false)}>关闭</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <Modal isOpen={confirmOpen} backdrop="blur" onClose={() => setConfirmOpen(false)}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="pb-2"><h2 className="m-0 text-lg font-semibold">删除结果</h2></ModalHeader>
              <ModalBody><p className="m-0">确定删除「{asset.name}」？删除后不可恢复。</p></ModalBody>
              <ModalFooter>
                <Button size="sm" variant="flat" onPress={() => setConfirmOpen(false)}>取消</Button>
                <Button size="sm" color="danger" isDisabled={!!busy} onPress={remove}>{busy === 'del' ? '删除中…' : '删除'}</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}

export function AssetGrid({ projectId, assets, kind, jobs, onRetry, onChanged }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
      {assets.map((a) => {
        const j = activeJobForAsset(jobs, a.id);
        return (
          <MediaCard
            key={a.id}
            projectId={projectId}
            asset={a}
            kind={kind}
            activeJobId={j ? j.id : ''}
            onRetry={onRetry}
            onChanged={onChanged}
          />
        );
      })}
    </div>
  );
}
