'use client';
import { useEffect, useState, useCallback } from 'react';
import { Button, Input, Card, CardBody, Textarea, Chip } from '@heroui/react';
import { api } from '../api-client.js';
import ReferencePicker from './ReferencePicker';
import { statusColor } from './shared';
import { useToast } from '../toast';

// ============ 页1 · 章节管理 ============
export default function ChaptersView({ projectId, chapters, cursor, setCursor, onRefresh }) {
  const toast = useToast();
  const cur = chapters[cursor] || chapters[0] || null;
  const [title, setTitle] = useState('');
  const [novel, setNovel] = useState('');
  const [dirty, setDirty] = useState(false);
  const [vision, setVision] = useState(false);
  const [refs, setRefs] = useState([]);
  const [savedRefs, setSavedRefs] = useState([]);

  useEffect(() => { if (cur) { setTitle(cur.title); setNovel(cur.novel || ''); setDirty(false); } }, [cur && cur.id]);
  useEffect(() => { api.get('/api/config').then((c) => setVision(!!c?.llm?.vision)).catch(() => {}); }, []);
  const loadRefs = useCallback(() => {
    api.get('/api/projects/' + projectId + '/references').then(setSavedRefs).catch(alert);
  }, [projectId]);
  useEffect(() => { loadRefs(); }, [loadRefs]);

  // 参考素材按章节归属：仅展示当前章（chapter_id = cur.id）的参考素材
  const chapterRefs = cur ? savedRefs.filter((r) => r.chapter_id === cur.id) : [];

  async function save() {
    try { await api.patch('/api/projects/' + projectId + '/chapters/' + cur.id, { title, novel }); toast.success('已保存「' + title + '」'); setDirty(false); onRefresh(); } catch (e) { toast.error(e.message); }
  }
  async function addChapter() {
    try { const c = await api.post('/api/projects/' + projectId + '/chapters', { title: '第' + (chapters.length + 1) + '章' }); toast.success('已新增章节'); onRefresh(); setCursor(Math.max(0, chapters.length)); } catch (e) { toast.error(e.message); }
  }
  async function removeChapter(c) {
    if (!(await toast.confirm('删除「' + c.title + '」及其分镜？此操作不可逆。', { danger: true }))) return;
    try { await api.del('/api/projects/' + projectId + '/chapters/' + c.id); toast.success('已删除「' + c.title + '」'); onRefresh(); } catch (e) { toast.error(e.message); }
  }
  async function move(i, dir) {
    const target = i + dir; if (target < 0 || target >= chapters.length) return;
    const a = chapters[i], b = chapters[target];
    try { await api.patch('/api/projects/' + projectId + '/chapters/' + a.id, { seq: b.seq }); await api.patch('/api/projects/' + projectId + '/chapters/' + b.id, { seq: a.seq }); onRefresh(); } catch (e) { toast.error(e.message); }
  }

  async function uploadRefs() {
    if (!cur) return;
    for (const it of refs) {
      const fd = new FormData();
      fd.append('file', it.file);
      fd.append('mode', it.mode);
      fd.append('category', it.category || 'other');
      fd.append('chapter_id', cur.id);
      fd.append('description', it.description || '');
      const res = await fetch('/api/projects/' + projectId + '/references', { method: 'POST', body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || ('参考图上传失败 HTTP ' + res.status));
      }
    }
    setRefs([]);
    loadRefs();
  }
  async function delRef(rid) {
    try { await api.del('/api/projects/' + projectId + '/references/' + rid); loadRefs(); } catch (e) { alert(e.message); }
  }
  async function updateRef(rid, patch) {
    // 乐观更新，失败回滚重载
    setSavedRefs((prev) => prev.map((r) => (r.id === rid ? { ...r, ...patch } : r)));
    try {
      await api.patch('/api/projects/' + projectId + '/references/' + rid, patch);
    } catch (e) { alert(e.message); loadRefs(); }
  }

  const label = { empty: '无分镜', pending: '待生成', running: '生成中', done: '完成', failed: '失败' };
  return (
    <Card>
      <CardBody className="gap-3">
        <div className="row justify-between">
          <h2 className="text-lg font-semibold m-0">章节管理</h2>
          <Button color="primary" size="sm" onPress={addChapter}>＋ 新增章节</Button>
        </div>
        <p className="muted">先规划整本书的章节骨架，然后在「生成内容」页逐章生成。素材库为全项目共用。</p>
        {chapters.map((c, i) => (
          <Card key={c.id} className={i === cursor ? 'border-primary' : ''}>
            <CardBody className="gap-2">
              <div className="row justify-between">
                <div className="row">
                  <b>{c.title}</b>
                  <Chip size="sm" variant="flat" color={statusColor(c.genStatus)}>{label[c.genStatus] || c.status}{c.shotCount > 0 ? ' · ' + c.doneCount + '/' + c.shotCount : ''}</Chip>
                </div>
                <div className="row">
                  <Button size="sm" color={i === cursor ? 'primary' : 'default'} variant={i === cursor ? 'solid' : 'flat'} onPress={() => setCursor(i)}>编辑</Button>
                  <Button size="sm" variant="flat" isIconOnly onPress={() => move(i, -1)}>↑</Button>
                  <Button size="sm" variant="flat" isIconOnly onPress={() => move(i, 1)}>↓</Button>
                  <Button size="sm" color="danger" variant="flat" onPress={() => removeChapter(c)}>删除</Button>
                </div>
              </div>
              {i === cursor && (
                <div className="flex flex-col gap-2">
                  <div className="row">
                    <Input size="sm" value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} placeholder="章节标题" className="w-40" />
                    <Button color="primary" size="sm" onPress={save} isDisabled={!dirty}>保存本章</Button>
                  </div>
                  <h3 className="text-sm m-0">本章小说原文</h3>
                  <Textarea size="sm" minRows={4} value={novel} onChange={(e) => { setNovel(e.target.value); setDirty(true); }} placeholder="粘贴或编辑本章原文…" />
                  <ReferencePicker
                    projectId={projectId}
                    items={refs}
                    onChange={setRefs}
                    saved={chapterRefs}
                    onUpdateSaved={updateRef}
                    onDeleteSaved={delRef}
                    allowAdd={vision}
                  />
                  {vision && refs.length > 0 && (
                    <div className="row">
                      <Button color="primary" size="sm" onPress={uploadRefs}>上传本章参考素材</Button>
                    </div>
                  )}
                </div>
              )}
            </CardBody>
          </Card>
        ))}
        {!chapters.length && <p className="muted">还没有章节，点「＋ 新增章节」。</p>}
      </CardBody>
    </Card>
  );
}