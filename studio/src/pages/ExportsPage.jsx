import { useCallback, useEffect, useState } from 'react';
import { CaptionsOff, Download, Film, Play, RefreshCw, Subtitles, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { exportTitle, fmtBytes, fmtTime, withSession } from '../lib/format.js';
import { Badge, Button, Checkbox, EmptyState } from '../components/ui.jsx';
import { Modal } from '../components/overlays.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useToast } from '../components/toast.jsx';

export default function ExportsPage({ projectId, readOnly = false, canExport = true, features = {} }) {
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [player, setPlayer] = useState(null);

  const load = useCallback(
    () => api.get('/api/projects/' + projectId + '/exports').then((r) => setFiles(r.files || [])).catch((e) => toast.error(e.message)),
    [projectId],
  );

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const allSelected = files.length > 0 && files.every((f) => selected.has(f.name));

  function toggle(name) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(files.map((f) => f.name)));
  }

  async function remove(names) {
    if (!names.length) return;
    setDeleting(true);
    try {
      const r = await api.del('/api/projects/' + projectId + '/exports', { files: names });
      const n = (r.deleted || []).length;
      if (n) toast.success('已删除 ' + n + ' 个成片');
      if (r.failed && r.failed.length) toast.error('部分文件删除失败：' + r.failed.join('、'));
      setSelected(new Set());
      setBatchMode(false);
      if (player && names.includes(player.name)) setPlayer(null);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDeleting(false);
    }
  }

  async function removeOne(f) {
    if (!(await toast.confirm('删除成片「' + f.name + '」？连同不带字幕版本与 SRT 字幕一起删除，不可恢复。', { danger: true }))) return;
    await remove([f.name]);
  }

  async function removeSelected() {
    const names = [...selected];
    if (!names.length) return;
    if (!(await toast.confirm('删除选中的 ' + names.length + ' 个成片？连同各自的不带字幕版本与 SRT 字幕一起删除，不可恢复。', { danger: true }))) return;
    await remove(names);
  }

  function download(f) {
    const a = document.createElement('a');
    a.href = withSession('/api/projects/' + projectId + '/exports/' + encodeURIComponent(f.name) + '/download');
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Delivery"
        title="成片"
        description="按章节平铺展示；点击封面预览，下载、字幕与删除都在卡片上。章节多时不再一条条向下堆整页视频。"
        actions={
          <>
            {files.length > 0 && !batchMode && canExport && features.buttons?.delete !== false ? (
              <Button variant="danger" size="md" onClick={() => setBatchMode(true)}>
                <Trash2 size={13} /> 批量删除
              </Button>
            ) : null}
            {batchMode && canExport && features.buttons?.delete !== false ? (
              <>
                <Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} label="全选" />
                <Button variant="danger" size="md" disabled={deleting || selected.size === 0} onClick={removeSelected}>
                  删除所选（{selected.size}）
                </Button>
                <Button variant="ghost" size="md" disabled={deleting} onClick={() => { setSelected(new Set()); setBatchMode(false); }}>
                  取消
                </Button>
              </>
            ) : null}
            <Button variant="secondary" size="md" disabled={deleting} onClick={load}>
              <RefreshCw size={13} /> 刷新
            </Button>
          </>
        }
      />

      {loading ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="panel overflow-hidden">
              <div className="skeleton aspect-video w-full" />
              <div className="flex flex-col gap-2 p-3">
                <div className="skeleton h-3 w-2/3 rounded" />
                <div className="skeleton h-3 w-1/3 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : files.length ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
          {files.map((f) => {
            const active = batchMode && selected.has(f.name);
            const title = exportTitle(f.name);
            return (
              <article
                key={f.rel}
                className={
                  'panel panel-hover group flex flex-col overflow-hidden transition-colors '
                  + (active ? 'border-[color-mix(in_srgb,var(--accent)_55%,transparent)]' : '')
                }
              >
                <div className="relative aspect-video overflow-hidden bg-black/40">
                  <video
                    src={withSession(f.url) + '#t=0.1'}
                    muted
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
                  />
                  <button
                    type="button"
                    onClick={() => setPlayer(f)}
                    className="absolute inset-0 flex items-center justify-center bg-black/10 text-white/85 opacity-0 transition-opacity hover:bg-black/25 group-hover:opacity-100"
                    aria-label={'播放 ' + title}
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/25 bg-black/55 backdrop-blur">
                      <Play size={16} />
                    </span>
                  </button>
                  {batchMode ? (
                    <span className="absolute left-2.5 top-2.5 rounded-lg border border-white/15 bg-black/55 p-1 backdrop-blur">
                      <Checkbox checked={selected.has(f.name)} onChange={() => toggle(f.name)} />
                    </span>
                  ) : null}
                  <span className="pointer-events-none absolute bottom-2.5 left-2.5 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[9.5px] text-white/75 backdrop-blur">
                    {fmtBytes(f.size)}
                  </span>
                </div>

                <div className="flex flex-1 flex-col gap-2.5 p-3">
                  <div className="min-w-0">
                    <h3 className="m-0 truncate text-[13px] font-medium text-[var(--fg)]" title={f.name}>{title}</h3>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[var(--fg-4)]">
                      <Badge tone="neutral">{title.split(' · ')[0]}</Badge>
                      <span>{fmtTime(f.mtime)}</span>
                    </div>
                  </div>
                  <div className="mt-auto flex flex-wrap items-center gap-1">
                    <Button variant="primary" size="sm" onClick={() => download(f)}>
                      <Download size={12} /> 下载
                    </Button>
                    {f.srt_name ? (
                      <Button variant="ghost" size="sm" onClick={() => download({ name: f.srt_name })}>
                        <Subtitles size={12} /> SRT
                      </Button>
                    ) : null}
                    {f.nosub_name ? (
                      <Button variant="ghost" size="sm" onClick={() => download({ name: f.nosub_name })}>
                        <CaptionsOff size={12} /> 无字幕
                      </Button>
                    ) : null}
                    {canExport && features.buttons?.delete !== false ? (
                      <Button variant="ghost" size="iconSm" title="删除" aria-label="删除" disabled={deleting} onClick={() => removeOne(f)} className="ml-auto">
                        <Trash2 size={13} className="text-[var(--danger)]" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            icon={Film}
            title="暂无成片"
            description="在「分镜审查」页导出本章成片，合并好的最终视频会出现在这里。"
          />
        </div>
      )}

      <Modal
        open={!!player}
        onOpenChange={(o) => !o && setPlayer(null)}
        title={player ? exportTitle(player.name) : '成片预览'}
        description={player ? fmtBytes(player.size) + ' · ' + fmtTime(player.mtime) : ''}
        size="xl"
        footer={
          player ? (
            <>
              {player.srt_name ? (
                <Button variant="secondary" size="md" onClick={() => download({ name: player.srt_name })}>
                  <Subtitles size={13} /> 下载 SRT
                </Button>
              ) : null}
              {player.nosub_name ? (
                <Button variant="secondary" size="md" onClick={() => download({ name: player.nosub_name })}>
                  <CaptionsOff size={13} /> 下载无字幕版
                </Button>
              ) : null}
              <Button variant="primary" size="md" onClick={() => download(player)}>
                <Download size={13} /> 下载成片
              </Button>
            </>
          ) : null
        }
      >
        {player ? (
          <video className="max-h-[68vh] w-full rounded-lg bg-black" controls autoPlay src={withSession(player.url)} />
        ) : null}
      </Modal>
    </div>
  );
}
