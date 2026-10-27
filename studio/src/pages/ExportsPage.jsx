import { useCallback, useEffect, useState } from 'react';
import { CaptionsOff, Download, Film, RefreshCw, Subtitles, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { exportTitle, fmtBytes, fmtTime, withSession } from '../lib/format.js';
import { Badge, Button, Checkbox, EmptyState } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useToast } from '../components/toast.jsx';

export default function ExportsPage({ projectId, readOnly = false, canExport = true, features = {} }) {
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
        description="导出后合并好的最终视频会出现在这里；开启自动字幕时会额外保留不带字幕版本与 SRT 字幕。"
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
        <div className="flex flex-col gap-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="panel p-4">
              <div className="skeleton h-4 w-1/3 rounded" />
              <div className="skeleton mt-3 aspect-video w-full rounded-xl" />
            </div>
          ))}
        </div>
      ) : files.length ? (
        <div className="flex flex-col gap-4">
          {files.map((f) => (
            <article key={f.rel} className="panel overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  {batchMode ? <Checkbox checked={selected.has(f.name)} onChange={() => toggle(f.name)} /> : null}
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)]">
                    <Film size={14} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="m-0 truncate text-[13.5px] font-medium text-[var(--fg)]" title={f.name}>
                      {exportTitle(f.name)}
                    </h3>
                    <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-[var(--fg-4)]">
                      <Badge tone="neutral">{fmtBytes(f.size)}</Badge>
                      <span>{fmtTime(f.mtime)}</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {f.srt_name ? (
                    <Button variant="ghost" size="sm" onClick={() => download({ name: f.srt_name })}>
                      <Subtitles size={12} /> SRT
                    </Button>
                  ) : null}
                  {f.nosub_name ? (
                    <Button variant="ghost" size="sm" onClick={() => download({ name: f.nosub_name })}>
                      <CaptionsOff size={12} /> 无字幕版
                    </Button>
                  ) : null}
                  <Button variant="primary" size="sm" onClick={() => download(f)}>
                    <Download size={12} /> 下载
                  </Button>
                  {canExport && features.buttons?.delete !== false ? (
                    <Button variant="ghost" size="iconSm" title="删除" aria-label="删除" disabled={deleting} onClick={() => removeOne(f)}>
                      <Trash2 size={13} className="text-[var(--danger)]" />
                    </Button>
                  ) : null}
                </div>
              </div>
              <video className="max-h-[440px] w-full bg-black" controls preload="metadata" src={withSession(f.url)} />
            </article>
          ))}
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
    </div>
  );
}
