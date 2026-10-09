'use client';
import { useEffect, useState, useCallback } from 'react';
import { Button, Input, Select, SelectItem, Card, CardBody, Textarea, Chip, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { STYLE_OPTIONS, STYLE_CUSTOM, resolveStyle, selectKeys, pickKey, statusColor } from './shared';
import ReferencePicker from './ReferencePicker';
import { useToast } from '../toast';

// ============ 项目列表 ============
export default function ProjectsPage({ onOpen }) {
  const toast = useToast();
  const [projects, setProjects] = useState([]);
  // 首次加载标记：数据回来之前不要显示「暂无项目」，否则用户会误以为项目丢了
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: '', novel: '', idea: '', style: '' });
  const [customStyle, setCustomStyle] = useState('');
  const [vision, setVision] = useState(false);
  const [refs, setRefs] = useState([]);
  const load = useCallback(() => api.get('/api/projects')
    .then(setProjects)
    .catch((e) => toast.error(e.message))
    .finally(() => setLoading(false)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/api/config').then((c) => setVision(!!c?.llm?.vision)).catch(() => {}); }, []);

  async function uploadReferences(projectId, chapterId) {
    for (const it of refs) {
      const fd = new FormData();
      fd.append('file', it.file);
      fd.append('mode', it.mode);
      fd.append('category', it.category || 'other');
      fd.append('chapter_id', chapterId);
      fd.append('description', it.description || '');
      const res = await fetch('/api/projects/' + projectId + '/references', { method: 'POST', body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || ('参考图上传失败 HTTP ' + res.status));
      }
    }
  }

  async function create() {
    try {
      const style = resolveStyle(form.style, customStyle);
      const p = await api.post('/api/projects', { ...form, style });
      if (refs.length) {
        const chapters = await api.get('/api/projects/' + p.id + '/chapters');
        await uploadReferences(p.id, (chapters[0] && chapters[0].id) || '');
      }
      onOpen(p.id);
    } catch (e) { toast.error(e.message); }
  }
  async function del(id) {
    if (!(await toast.confirm('删除该项目及其所有素材？', { danger: true }))) return;
    try { await api.del('/api/projects/' + id); toast.success('已删除'); load(); } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="gap-3">
          <h2 className="text-lg font-semibold m-0">新建项目</h2>
          <div className="row">
            <Input size="sm" placeholder="项目名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-48" />
            <Select
              size="sm"
              className="w-60"
              aria-label="画面风格"
              placeholder="选择画面风格（可选）"
              selectedKeys={selectKeys(form.style)}
              onSelectionChange={(k) => setForm({ ...form, style: pickKey(k) })}
            >
              <SelectItem key="">选择画面风格（可选）</SelectItem>
              {STYLE_OPTIONS.map((s) => <SelectItem key={s}>{s}</SelectItem>)}
            </Select>
            {form.style === STYLE_CUSTOM && (
              <Input size="sm" placeholder="请填写自定义风格" value={customStyle} onChange={(e) => setCustomStyle(e.target.value)} className="w-60" />
            )}
          </div>
          <Textarea size="sm" placeholder="粘贴小说原文（可留空，用下方一句话想法）" value={form.novel} onChange={(e) => setForm({ ...form, novel: e.target.value })} />
          <Input size="sm" placeholder="或：一句话故事想法" value={form.idea} onChange={(e) => setForm({ ...form, idea: e.target.value })} />
          {vision && <ReferencePicker items={refs} onChange={setRefs} />}
          <div>
            <Button color="primary" isDisabled={!form.name} onPress={create}>创建并打开</Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="gap-2">
          <h2 className="text-lg font-semibold m-0">项目列表</h2>
          {loading && (
            <div className="flex items-center justify-center gap-2.5 py-6">
              <Spinner size="sm" />
              <span className="muted">项目加载中…</span>
            </div>
          )}
          {!loading && projects.map((p) => (
            <div key={p.id} className="row justify-between py-2 border-b border-default-100">
              <div className="flex items-center gap-2">
                <button onClick={() => onOpen(p.id)} className="bg-transparent border-0 p-0 text-[15px] cursor-pointer text-primary"> {p.name}</button>
                <span className="muted">资产 {p.assetCount} · 分镜 {p.shotCount} ·</span>
                <Chip size="sm" variant="flat" color={statusColor(p.status)}>{p.status || 'idle'}</Chip>
              </div>
              <Button size="sm" color="danger" variant="flat" onPress={() => del(p.id)}>删除</Button>
            </div>
          ))}
          {!loading && !projects.length && <p className="muted">暂无项目</p>}
        </CardBody>
      </Card>
    </div>
  );
}
