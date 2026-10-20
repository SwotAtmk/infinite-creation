'use client';
import { useEffect, useState, useCallback } from 'react';
import { Card, CardBody, Button, Spinner, Checkbox } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';

// ============ 成片（导出视频） ============
export default function ExportsTab({ projectId }) {
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const load = useCallback(() => api.get('/api/projects/' + projectId + '/exports').then((r) => setFiles(r.files || [])).catch((e) => toast.error(e.message)), [projectId]);
  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [load]);

  const allSelected = files.length > 0 && files.every((f) => selected.has(f.name));

  function toggle(name) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(files.map((f) => f.name)));
  }
  function cancelBatch() {
    setSelected(new Set());
    setBatchMode(false);
  }
  // 删除（单个/批量共用）：后端会连带清理「不带字幕」副本与 SRT 字幕
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
    } catch (e) { toast.error(e.message); }
    finally { setDeleting(false); }
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

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function fmtTime(ms) { try { return new Date(ms).toLocaleString('zh-CN'); } catch { return ''; } }
  // 文件名形如「项目名_第1章_uid.mp4」：把章节提到标题最前面，其余部分交给省略号截断
  function titleOf(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '');
    const m = base.match(/第[0-9一二三四五六七八九十百零两]+章/);
    if (!m) return base;
    const rest = base.replace(m[0], '').replace(/^_+|_+$/g, '');
    return rest ? m[0] + ' · ' + rest : m[0];
  }
  function download(f) {
    const a = document.createElement('a');
    a.href = '/api/projects/' + projectId + '/exports/' + encodeURIComponent(f.name) + '/download';
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  if (loading) {
    return (
      <Card>
        <CardBody className="flex-row items-center justify-center gap-2.5 py-10">
          <Spinner size="sm" />
          <span className="muted">成片数据加载中…</span>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="gap-2">
        <div className="row justify-between">
          <h2 className="m-0">成片（{files.length}）</h2>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            {/* 默认只给「批量删除」入口；点击后才展开全选与删除所选 */}
            {files.length > 0 && !batchMode && (
              <Button size="sm" color="danger" variant="flat" onPress={() => setBatchMode(true)}>批量删除</Button>
            )}
            {batchMode && (
              <>
                <Checkbox size="sm" isSelected={allSelected} isIndeterminate={selected.size > 0 && !allSelected} onValueChange={toggleAll}>全选</Checkbox>
                <Button size="sm" color="danger" variant="flat" isDisabled={deleting || selected.size === 0} onPress={removeSelected}>删除所选（{selected.size}）</Button>
                <Button size="sm" variant="light" isDisabled={deleting} onPress={cancelBatch}>取消</Button>
              </>
            )}
            <Button size="sm" variant="flat" isDisabled={deleting} onPress={load}>刷新</Button>
          </div>
        </div>
        <p className="muted" style={{ marginTop: 6 }}>
          在「生成内容」页点「导出本章成片」后，合并好的最终视频会出现在这里，可在线预览或下载；开启「自动添加字幕」时字幕会直接烧录进画面，并额外保留一份不带字幕的版本与 SRT 字幕文件供下载。
        </p>
        {!files.length && <p className="muted">暂无成片，请先在「生成内容」页完成某章并点击「导出本章成片」。</p>}
        {files.map((f) => (
          <Card key={f.rel} shadow="none" className="border border-default-200 mt-3 bg-default-50">
            <CardBody className="gap-2">
              {/* 不换行：标题过长时用省略号收缩，避免把右侧操作按钮挤到下一行 */}
              <div className="row justify-between" style={{ flexWrap: 'nowrap', gap: 12 }}>
                <div className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0, flexWrap: 'nowrap', flex: '1 1 auto' }}>
                  {batchMode && (
                    <Checkbox size="sm" isSelected={selected.has(f.name)} onValueChange={() => toggle(f.name)} aria-label={'选择 ' + f.name} />
                  )}
                  <b title={f.name} style={{ minWidth: 0, flex: '1 1 auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {titleOf(f.name)}
                  </b>
                </div>
                <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                  <span className="muted">{fmtBytes(f.size)} · {fmtTime(f.mtime)}</span>
                  {f.srt_name && (
                    <Button size="sm" variant="flat" onPress={() => download({ name: f.srt_name })}>下载SRT字幕文件</Button>
                  )}
                  {f.nosub_name && (
                    <Button size="sm" variant="flat" onPress={() => download({ name: f.nosub_name })}>下载【不带字幕】</Button>
                  )}
                  <Button size="sm" color="primary" onPress={() => download(f)}>下载</Button>
                  <Button size="sm" color="danger" variant="flat" isDisabled={deleting} onPress={() => removeOne(f)}>删除</Button>
                </div>
              </div>
              <video className="video" controls preload="metadata" src={f.url} style={{ maxHeight: 420, marginTop: 8 }} />
            </CardBody>
          </Card>
        ))}
      </CardBody>
    </Card>
  );
}