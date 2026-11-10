'use client';
// 无限・卷轴（经典界面）：顶部横置 Tabs 分 章节 / 大纲 / 角色 / 记忆
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardBody, Button, Chip, Input, Textarea, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Tab, Tabs } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import { useJobs } from './simpleStudio';

const STEP_LABEL = { outline: '总纲', volumes: '分卷', chapters: '章纲', write: '正文', start: '整本生成', restart: '全部重新生成', all: '全部大纲' };

function safeFileName(s) {
  return String(s || '未命名小说').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80) || '未命名小说';
}

function downloadTxt(filename, text) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith('.txt') ? filename : filename + '.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// groups: [{ seq, title, items: [chapter] }]
function buildBookText({ bookName, idea, groups }) {
  const lines = [String(bookName || '未命名小说')];
  if (idea) lines.push('', String(idea).trim());
  for (const g of groups) {
    const items = g.items.filter((c) => String(c.novel || '').trim());
    if (!items.length) continue;
    lines.push('', '====================', `第${g.seq}卷${g.title ? ' ' + g.title : ''}`, '====================');
    for (const c of items) lines.push('', c.title || '未命名', '', String(c.novel).trim());
  }
  return lines.join('\n') + '\n';
}

function buildChapterText(c) {
  return [c.title || '未命名', '', String(c.novel || '').trim()].join('\n') + '\n';
}

export default function NovelPage({ onOpenAgentProject }) {
  const toast = useToast();
  const [novels, setNovels] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [panel, setPanel] = useState('chapters');
  // 标题/中心思想编辑（Hook 必须在任何提前 return 之前）
  const [editingInfo, setEditingInfo] = useState(false);
  const [infoName, setInfoName] = useState('');
  const [infoIdea, setInfoIdea] = useState('');

  const { jobs: projectJobs, reloadJobs } = useJobs(selected?.id);
  const novelJobs = useMemo(() => (projectJobs || []).filter((j) => j.type === 'novel'), [projectJobs]);
  const running = novelJobs.find((j) => j.status === 'running' || j.status === 'queued');

  const loadNovels = useCallback(async () => {
    try {
      const res = await api.get('/api/projects?type=novel');
      setNovels(Array.isArray(res?.items) ? res.items : (Array.isArray(res) ? res : []));
    } catch {}
  }, []);

  const loadSelected = useCallback(async (id) => {
    try {
      const data = await api.get('/api/projects/' + id + '/novel');
      setSelected({ ...data, id: data?.project?.id || id });
    } catch {}
  }, []);

  async function delNovel(n) {
    if (!(await toast.confirm('删除「' + (n.name || '未命名') + '」及其全部大纲、角色、章节正文？此操作不可逆。', { danger: true }))) return;
    try {
      await api.del('/api/projects/' + n.id);
      toast.success('已删除');
      if (selected?.id === n.id) setSelected(null);
      loadNovels();
    } catch (e) { toast.error('删除失败：' + (e?.message || String(e))); }
  }

  useEffect(() => { loadNovels(); }, [loadNovels]);

  const jobsSig = novelJobs.map((j) => j.id + ':' + j.status).join(',');
  useEffect(() => {
    if (!selected?.id) return;
    const hasFinished = novelJobs.some((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled');
    if (!hasFinished) return;
    const t = setTimeout(() => { loadSelected(selected.id); loadNovels(); }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsSig]);

  // 任务运行中每 5 秒刷新一次，实时看到新生成的卷/章节/正文
  const runningJobId = running ? running.id : '';
  useEffect(() => {
    if (!selected?.id || !runningJobId) return;
    const t = setInterval(() => { loadSelected(selected.id).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [selected?.id, runningJobId, loadSelected]);

  async function startStep(step, chapter) {
    if (!selected) return;
    if (running) { toast.error('该小说正在生成中，请等它结束'); return; }
    try {
      await api.post('/api/projects/' + selected.id + '/novel', { step, chapter: chapter || '' });
      toast.success('开始' + (STEP_LABEL[step] || step) + (chapter ? '「' + chapter + '」' : '') + '...');
      reloadJobs();
    } catch (e) {
      toast.error('启动失败：' + (e?.message || String(e)));
    }
  }

  async function saveStructure(k, v) {
    if (!selected) return;
    try {
      const patch = { structure: { ...(selected.structure || {}), [k]: v } };
      const data = await api.put('/api/projects/' + selected.id + '/novel', patch);
      setSelected((prev) => ({ ...prev, ...data, id: prev?.id, project: prev?.project, chapters: prev?.chapters }));
      toast.success('已保存');
    } catch (e) { toast.error('保存失败：' + (e?.message || String(e))); }
  }

  async function saveCharacters(next) {
    if (!selected) return;
    try {
      const data = await api.put('/api/projects/' + selected.id + '/novel', { characters: next });
      setSelected((prev) => ({ ...prev, ...data, id: prev?.id, project: prev?.project, chapters: prev?.chapters }));
      toast.success('角色已更新');
    } catch (e) { toast.error(e?.message || String(e)); }
  }

  async function saveMemory(next) {
    if (!selected) return;
    try {
      const data = await api.put('/api/projects/' + selected.id + '/novel', { memory: next });
      setSelected((prev) => ({ ...prev, ...data, id: prev?.id, project: prev?.project, chapters: prev?.chapters }));
      toast.success('记忆已更新');
    } catch (e) { toast.error(e?.message || String(e)); }
  }

  async function saveVolumes(next) {
    if (!selected) return;
    try {
      const data = await api.put('/api/projects/' + selected.id + '/novel', { volumes: next });
      setSelected((prev) => ({ ...prev, ...data, id: prev?.id, project: prev?.project, chapters: prev?.chapters }));
      toast.success('分卷已更新');
    } catch (e) { toast.error('保存失败：' + (e?.message || String(e))); }
  }

  async function updateProjectNameIdea(name, idea) {
    if (!selected) return;
    try {
      await api.patch('/api/projects/' + selected.id, { name, idea });
      toast.success('已更新');
      loadNovels();
      loadSelected(selected.id);
    } catch (e) { toast.error(e?.message || String(e)); }
  }

  async function importToAgent() {
    if (!selected) return;
    try {
      const r = await api.post('/api/projects/' + selected.id + '/novel/import');
      toast.success('已创建视频项目：' + r.name + '（迁移 ' + (r.chapters || 0) + ' 章 / ' + (r.characters || 0) + ' 个角色）');
      if (onOpenAgentProject) onOpenAgentProject(r.id);
    } catch (e) { toast.error('小说转视频失败：' + (e?.message || String(e))); }
  }

  async function stopJob() {
    if (!selected?.id || !running?.id) return;
    try {
      await api.post('/api/projects/' + selected.id + '/jobs/' + running.id + '/cancel');
      toast.success('已停止生成');
      reloadJobs();
    } catch (e) { toast.error('停止失败：' + (e?.message || String(e))); }
  }

  // —— 列表态 ——
  if (!selected) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold m-0">无限・卷轴</h2>
            <p className="text-default-500 text-sm m-0 mt-1">写小说：逐章正文 · 大纲 · 角色 · 上下文记忆</p>
          </div>
          <Button color="primary" onPress={() => setShowNew(true)}>＋ 新建小说</Button>
        </div>

        {novels.length === 0 ? (
          <Card><CardBody className="text-center py-10 text-default-500">还没有小说 · 点右上角新建</CardBody></Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {novels.map((n) => (
              <Card key={n.id} isPressable onPress={() => loadSelected(n.id)}>
                <CardBody>
                  <div className="flex h-24 items-center justify-center rounded-lg bg-default-100 mb-3">
                    <span className="text-default-400 text-[11px] tracking-widest">NOVEL</span>
                  </div>
                  <div className="font-medium truncate">{n.name || '未命名'}</div>
                  {n.idea ? <p className="text-xs text-default-500 line-clamp-2 mt-1 m-0">{n.idea}</p> : null}
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs text-default-400">打开写作 →</span>
                    <Button
                      size="sm"
                      variant="light"
                      color="danger"
                      isIconOnly
                      aria-label={'删除小说 ' + (n.name || '未命名')}
                      onClick={(e) => e.stopPropagation()}
                      onPress={() => delNovel(n)}
                    >
                      🗑
                    </Button>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
        <NewNovelModal open={showNew} onClose={() => setShowNew(false)} onCreate={(p) => loadSelected(p.id)} />
      </div>
    );
  }

  const structure = selected.structure || {};
  const characters = selected.characters || [];
  const memory = selected.memory || [];
  const chapters = selected.chapters || [];

  function openEditInfo() {
    setInfoName(selected.project?.name || '');
    setInfoIdea(selected.project?.idea || '');
    setEditingInfo(true);
  }
  async function saveInfo() {
    if (!infoName.trim()) { toast.error('标题不能为空'); return; }
    await updateProjectNameIdea(infoName.trim(), infoIdea.trim());
    setEditingInfo(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="flat" onPress={() => setSelected(null)}>← 返回列表</Button>
            <h2 className="text-xl font-semibold m-0 truncate">{selected.project?.name || '未命名'}</h2>
            {running ? <Chip color="warning" variant="bordered">生成中 · {STEP_LABEL[(running.checkpoint || {}).step] || '大纲'}</Chip> : null}
          </div>
          {selected.project?.idea ? <p className="text-default-500 text-xs m-0 mt-1">{selected.project.idea}</p> : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="flat" onPress={openEditInfo}>✎ 编辑信息</Button>
          <Button color="primary" size="sm" onPress={importToAgent} isDisabled={!!running}>
            ✨ 小说转视频
          </Button>
        </div>
      </div>

      {editingInfo ? (
        <Card>
          <CardBody className="flex flex-col gap-3">
            <Input label="小说标题" value={infoName} onChange={(e) => setInfoName(e.target.value)} />
            <Textarea label="中心思想 / 故事梗概" rows={3} value={infoIdea} onChange={(e) => setInfoIdea(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="flat" onPress={() => setEditingInfo(false)}>取消</Button>
              <Button size="sm" color="primary" onPress={saveInfo}>保存</Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Tabs selectedKey={panel} onSelectionChange={(k) => setPanel(String(k))} variant="underlined">
        <Tab key="chapters" title={'章节 ' + (chapters.length ? '(' + chapters.length + ')' : '')} />
        <Tab key="outline" title="大纲" />
        <Tab key="characters" title={'角色 ' + (characters.length ? '(' + characters.length + ')' : '')} />
        <Tab key="memory" title={'记忆 ' + (memory.length ? '(' + memory.length + ')' : '')} />
      </Tabs>

      {panel === 'chapters' ? (
        <ChaptersPanel
          projectId={selected.id}
          projectName={selected.project?.name || ''}
          projectIdea={selected.project?.idea || ''}
          chapters={chapters}
          volumes={selected.volumes || []}
          running={!!running}
          onRefresh={() => loadSelected(selected.id)}
          onSaveVolumes={saveVolumes}
          onStart={() => startStep('start')}
          onRestart={() => startStep('restart')}
          onStop={stopJob}
          onWriteOne={(title) => startStep('write', title)}
        />
      ) : null}

      {panel === 'outline' ? (
        <OutlinePanel structure={structure} running={!!running} onSave={saveStructure} onGenerate={startStep} />
      ) : null}

      {panel === 'characters' ? <CharactersCard characters={characters} onChange={saveCharacters} /> : null}
      {panel === 'memory' ? <MemoryCard memory={memory} onChange={saveMemory} /> : null}

      <NewNovelModal open={showNew} onClose={() => setShowNew(false)} onCreate={(p) => loadSelected(p.id)} />
    </div>
  );
}

// —— 章节板块（按卷分组，每卷显示本卷卷纲）——
function ChaptersPanel({ projectId, projectName, projectIdea, chapters, volumes, running, onRefresh, onSaveVolumes, onStart, onRestart, onStop, onWriteOne }) {
  const toast = useToast();
  const [showPreview, setShowPreview] = useState(false);
  const [editing, setEditing] = useState(null); // { id?, title, novel, volume, outline }
  const [editingVolume, setEditingVolume] = useState(null); // { seq, title, outline }
  const [volTitle, setVolTitle] = useState('');
  const [volOutline, setVolOutline] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftNovel, setDraftNovel] = useState('');
  const [draftVolume, setDraftVolume] = useState(1);
  const [draftOutline, setDraftOutline] = useState('');
  const [busy, setBusy] = useState(false);

  function openEdit(c) { setEditing(c); setDraftTitle(c.title || ''); setDraftNovel(c.novel || ''); setDraftVolume(c.volume || 1); setDraftOutline(c.outline || ''); }
  function close() { setEditing(null); }

  async function saveChapter() {
    setBusy(true);
    try {
      const body = { title: draftTitle.trim(), novel: draftNovel, volume: Number(draftVolume) || 1, outline: draftOutline };
      if (editing.id) {
        await api.patch('/api/projects/' + projectId + '/chapters/' + editing.id, body);
      } else {
        await api.post('/api/projects/' + projectId + '/chapters', body);
      }
      toast.success('已保存');
      close();
      onRefresh();
    } catch (e) { toast.error(e?.message || String(e)); } finally { setBusy(false); }
  }

  async function removeChapter(c) {
    if (!(await toast.confirm('删除「' + c.title + '」？此操作不可逆。', { danger: true }))) return;
    try {
      await api.del('/api/projects/' + projectId + '/chapters/' + c.id);
      toast.success('已删除');
      onRefresh();
    } catch (e) { toast.error(e?.message || String(e)); }
  }

  // 按卷分组：以结构化 volumes 为准，章节按 volume 归入；老数据按章节 volume 兜底分组
  const groups = useMemo(() => {
    const map = new Map();
    for (const v of volumes || []) {
      const seq = Number(v.seq) || 1;
      map.set(seq, { seq, title: v.title || '', outline: v.outline || '', items: [] });
    }
    for (const c of chapters) {
      const seq = Number(c.volume) || 1;
      if (!map.has(seq)) map.set(seq, { seq, title: '', outline: '', items: [] });
      map.get(seq).items.push(c);
    }
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }, [chapters, volumes]);

  function openEditVolume(g) { setEditingVolume(g); setVolTitle(g.title || ''); setVolOutline(g.outline || ''); }
  async function saveVolume() {
    const seq = Number(editingVolume?.seq) || 1;
    const base = (volumes || []).map((v) => ({ ...v }));
    const idx = base.findIndex((v) => Number(v.seq) === seq);
    const patch = { seq, title: volTitle.trim(), outline: volOutline };
    if (idx >= 0) base[idx] = { ...base[idx], ...patch };
    else base.push(patch);
    base.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    await onSaveVolumes(base);
    setEditingVolume(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" color="primary" onPress={onStart} isDisabled={running}>
          ✨ {running ? '生成中…' : '开始生成 / 继续'}
        </Button>
        <Button
          size="sm"
          variant="flat"
          isDisabled={running}
          onPress={async () => {
            if (!(await toast.confirm('「全部重新生成」会清空当前的大纲、角色、卷、章节和正文，从零重新生成，确定？', { danger: true }))) return;
            onRestart();
          }}
        >
          全部重新生成
        </Button>
        <Button
          size="sm"
          variant="flat"
          isDisabled={running || !chapters.some((c) => String(c.novel || '').trim())}
          onPress={() => downloadTxt(safeFileName(projectName), buildBookText({ bookName: projectName, idea: projectIdea, groups }))}
        >
          导出全文 TXT
        </Button>
        <Button size="sm" variant="flat" isDisabled={running || chapters.length === 0} onPress={() => setShowPreview(true)}>
          预览
        </Button>
        {running ? (
          <Button size="sm" color="danger" onPress={onStop}>停止</Button>
        ) : null}
        <span className="text-xs text-default-500">
          自动依次生成：总纲 → 角色 → 分卷 → 章节 → 章纲 → 正文；中断后再点「开始生成 / 继续」会从断点续跑
        </span>
      </div>

      {chapters.length === 0 && groups.length === 0 ? (
        <Card><CardBody className="text-center py-10 text-default-500">还没有章节 · 点「开始生成」让 Agent 按 总纲 → 角色 → 分卷 → 章节 → 章纲 → 正文 自动生成整本小说</CardBody></Card>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <Card key={g.seq}>
              <CardBody>
                <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[15px] font-semibold m-0">第{g.seq}卷{g.title ? ' · ' + g.title : ''}</h3>
                      <Chip size="sm" variant="flat">{g.items.length} 章</Chip>
                    </div>
                    {g.outline ? (
                      <p className="text-default-600 text-xs whitespace-pre-wrap m-0 mt-1.5 bg-default-100 rounded-lg px-2.5 py-1.5">
                        <span className="text-default-400">本卷卷纲：</span>{g.outline}
                      </p>
                    ) : (
                      <p className="text-default-400 text-xs m-0 mt-1.5">还没有本卷卷纲（点「编辑卷」补充，或让 Agent 生成）</p>
                    )}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Button size="sm" variant="flat" onPress={() => openEditVolume(g)}>编辑卷</Button>
                  </div>
                </div>

                {g.items.length === 0 ? (
                  <p className="text-default-400 text-xs text-center py-4 border border-dashed border-default-200 rounded-lg m-0">本卷还没有章节</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {g.items.map((c) => {
                      const i = chapters.indexOf(c);
                      const wordCount = String(c.novel || '').length;
                      return (
                        <Card key={c.id} shadow="sm" isPressable onPress={() => openEdit(c)}>
                          <CardBody>
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-default-400 text-[10px] tracking-widest m-0">CHAPTER {String(i + 1).padStart(2, '0')}</p>
                                <h3 className="text-sm font-medium m-0 mt-0.5 truncate" title={c.title}>{c.title || '未命名'}</h3>
                              </div>
                              <div className="flex gap-1 shrink-0">
                                <Button size="sm" variant="flat" isIconOnly onClick={(e) => e.stopPropagation()} onPress={() => removeChapter(c)}>🗑</Button>
                              </div>
                            </div>
                            {c.outline ? (
                              <p className="text-default-500 text-xs line-clamp-3 mt-2 m-0 bg-default-100 rounded-lg px-2 py-1.5" title={c.outline}>
                                <span className="text-default-400">章纲：</span>{c.outline}
                              </p>
                            ) : (
                              <p className="text-default-400 text-[11px] mt-2 m-0">还没有本章章纲</p>
                            )}
                            <p className="text-default-500 text-xs line-clamp-3 mt-2 m-0">
                              {wordCount ? String(c.novel || '').slice(0, 140) : '（还没有正文）'}
                            </p>
                            <div className="flex items-center justify-between gap-2 mt-3">
                              <span className="text-default-400 text-[11px]">{wordCount ? wordCount.toLocaleString() + ' 字' : '未写'}</span>
                              <div className="flex gap-1">
                                <Button
                                  size="sm"
                                  variant="flat"
                                  isDisabled={!wordCount}
                                  onClick={(e) => e.stopPropagation()}
                                  onPress={() => downloadTxt(safeFileName(projectName + '-' + (c.title || '未命名')), buildChapterText(c))}
                                >
                                  导出
                                </Button>
                                <Button size="sm" variant="flat" isDisabled={running} onClick={(e) => e.stopPropagation()} onPress={() => onWriteOne(c.title)}>
                                  重新生成
                                </Button>
                              </div>
                            </div>
                          </CardBody>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal isOpen={!!editing} onClose={close}>
        <ModalContent>
          <ModalHeader>{editing?.id ? '编辑章节' : '新增章节'}</ModalHeader>
          <ModalBody>
            <div className="flex flex-col gap-3">
              <div className="flex gap-3">
                <Input className="w-28 shrink-0" type="number" min={1} label="所属卷号" value={String(draftVolume)} onChange={(e) => setDraftVolume(Number(e.target.value) || 1)} />
                <Input label="章节标题" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="第1章 意外穿越" />
              </div>
              <Textarea label="本章章纲" rows={3} value={draftOutline} onChange={(e) => setDraftOutline(e.target.value)} placeholder="这一章要写什么：本章目标 / 阻碍 / 变化 / 章末钩子" />
              <Textarea label="本章正文" rows={14} value={draftNovel} onChange={(e) => setDraftNovel(e.target.value)} placeholder="粘贴或编辑本章正文…" />
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={close}>取消</Button>
            <Button color="primary" onPress={saveChapter} isLoading={busy}>保存本章</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={!!editingVolume} onClose={() => setEditingVolume(null)}>
        <ModalContent>
          <ModalHeader>第{Number(editingVolume?.seq) || 1}卷 · 卷纲</ModalHeader>
          <ModalBody>
            <div className="flex flex-col gap-3">
              <Input label="卷名" value={volTitle} onChange={(e) => setVolTitle(e.target.value)} placeholder="第一卷 山门" />
              <Textarea label="本卷卷纲" rows={8} value={volOutline} onChange={(e) => setVolOutline(e.target.value)} placeholder="这一卷要写什么：核心目标 / 主要冲突 / 卷末变化 / 覆盖第几章到第几章" />
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setEditingVolume(null)}>取消</Button>
            <Button color="primary" onPress={saveVolume}>保存卷</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <PreviewModal open={showPreview} onClose={() => setShowPreview(false)} bookName={projectName} groups={groups} />
    </div>
  );
}

// —— 在线预览：左侧卷/章目录，右侧一页一章，翻页带翻书动效 ——
function PreviewModal({ open, onClose, bookName, groups }) {
  const pages = useMemo(
    () => (groups || []).flatMap((g) => g.items.map((c) => ({ chapter: c, volSeq: g.seq, volTitle: g.title || '' }))),
    [groups],
  );
  const [page, setPage] = useState(1); // 1-based
  const [dir, setDir] = useState('next');
  const [flipKey, setFlipKey] = useState(0);
  const [jump, setJump] = useState('1');
  const [q, setQ] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setPage(1);
    setJump('1');
    setQ('');
    setDir('next');
    setFlipKey((k) => k + 1);
  }, [open]);
  useEffect(() => { setJump(String(page)); }, [page]);

  const total = pages.length;
  const current = pages[page - 1];

  function go(target, from) {
    const n = Math.min(Math.max(Number(target) || 1, 1), total || 1);
    // 翻页后正文滚动条回到顶部
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setDir(from || (n >= page ? 'next' : 'prev'));
    setPage(n);
    setFlipKey((k) => k + 1);
  }

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(Math.min(page + 1, total), 'next'); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(Math.max(page - 1, 1), 'prev'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, page, total]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return groups || [];
    return (groups || [])
      .map((g) => ({ ...g, items: g.items.filter((c) => String(c.title || '').toLowerCase().includes(kw)) }))
      .filter((g) => g.items.length);
  }, [groups, q]);

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      size="5xl"
      scrollBehavior="inside"
      classNames={{ base: 'h-[86vh] max-h-[86vh]', body: 'p-0 overflow-hidden' }}
    >
      <ModalContent className="h-full">
        <ModalHeader className="border-b border-default-200 py-3">
          <div className="flex w-full flex-wrap items-center gap-2">
            <span className="text-base font-semibold">预览 · {bookName || '未命名小说'}</span>
            <span className="text-xs text-default-500 ml-auto">共 {total} 章</span>
          </div>
        </ModalHeader>
        <ModalBody className="flex flex-col !p-0 !overflow-hidden">
          <div className="flex h-full min-h-0 flex-col">
            {/* 顶部页码栏 */}
            <div className="flex flex-wrap items-center gap-2 border-b border-default-200 px-4 py-2.5">
              <Button size="sm" variant="flat" isDisabled={page <= 1} onPress={() => go(page - 1, 'prev')}>上一页</Button>
              <span className="text-xs text-default-500">第</span>
              <input
                value={jump}
                onChange={(e) => setJump(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') go(jump); }}
                inputMode="numeric"
                aria-label="跳转到页码"
                className="h-7 w-14 rounded-md border border-default-200 bg-default-100 px-2 text-center text-xs outline-none focus:border-primary"
              />
              <span className="text-xs text-default-500">/ {total} 页</span>
              <Button size="sm" variant="flat" isDisabled={!total} onPress={() => go(jump)}>跳转</Button>
              <Button size="sm" variant="flat" isDisabled={page >= total} onPress={() => go(page + 1, 'next')}>下一页</Button>
              <span className="ml-auto text-[11px] text-default-400">一页一章 · ← → 翻页</span>
            </div>

            <div className="flex min-h-0 flex-1">
              {/* 左：目录 */}
              <aside className="flex w-56 shrink-0 flex-col border-r border-default-200">
                <div className="border-b border-default-200 p-2.5">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="筛选目录…"
                    className="h-8 w-full rounded-lg border border-default-200 bg-default-100 px-2.5 text-xs outline-none focus:border-primary"
                  />
                </div>
                <nav className="min-h-0 flex-1 overflow-y-auto p-2">
                  {filtered.length === 0 ? <p className="text-center text-xs text-default-400 py-4 m-0">没有匹配的章节</p> : null}
                  {filtered.map((g) => (
                    <div key={g.seq} className="mb-2">
                      <p className="text-[10px] tracking-widest text-default-400 px-2 py-1 m-0">
                        第{g.seq}卷{g.title ? ' · ' + g.title : ''}
                      </p>
                      {g.items.map((c) => {
                        const idx = pages.findIndex((p) => p.chapter.id === c.id) + 1;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => go(idx, idx >= page ? 'next' : 'prev')}
                            className={
                              'block w-full truncate rounded-md px-2 py-1.5 text-left text-xs transition-colors '
                              + (idx === page ? 'bg-primary-50 text-primary' : 'text-default-700 hover:bg-default-100')
                            }
                          >
                            {c.title || '未命名'}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </nav>
              </aside>

              {/* 右：正文 */}
              <section className="flex min-w-0 flex-1 flex-col">
                <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-6" style={{ perspective: '1800px' }}>
                  {current ? (
                    <div key={page + ':' + flipKey} className={dir === 'prev' ? 'novel-flip-prev' : 'novel-flip-next'}>
                      <p className="text-[10px] tracking-widest text-default-400 m-0">
                        第{current.volSeq}卷{current.volTitle ? ' · ' + current.volTitle : ''} · PAGE {page}/{total}
                      </p>
                      <h3 className="text-lg font-semibold mt-1.5 m-0">{current.chapter.title || '未命名'}</h3>
                      <article className="mt-4 whitespace-pre-wrap text-sm leading-8 text-default-700">
                        {String(current.chapter.novel || '').trim() || '（本章还没有正文）'}
                      </article>
                    </div>
                  ) : (
                    <p className="text-sm text-default-400">还没有章节</p>
                  )}
                </div>
              </section>
            </div>
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

// —— 大纲板块：只有总纲（卷纲在「章节」板块按卷展示，章纲绑定到每章）——
function OutlinePanel({ structure, running, onSave, onGenerate }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => { setEditing(false); setDraft(structure.outline || ''); }, [structure]);

  function startEdit() { setDraft(structure.outline || ''); setEditing(true); }

  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <span className="text-sm font-medium">总纲</span>
          <Button size="sm" variant="flat" isDisabled={running} onPress={() => onGenerate('outline')}>生成总纲</Button>
        </div>

        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea rows={16} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="flat" onPress={() => setEditing(false)}>取消</Button>
              <Button size="sm" color="primary" onPress={() => { setEditing(false); onSave('outline', draft); }}>保存</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {structure.outline ? (
              <pre className="whitespace-pre-wrap text-sm leading-relaxed bg-default-100 rounded-lg p-4">{structure.outline}</pre>
            ) : (
              <div className="text-center text-default-400 py-12 text-sm">
                总纲：一句话 hook · 题材与卖点 · 故事引擎 · 目标长度 · 第一卷目标与卷末变化 · 点「生成总纲」让 Agent 写，或点「编辑」手动写
              </div>
            )}
            <div className="flex justify-end">
              <Button size="sm" variant="flat" onPress={startEdit}>编辑</Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// —— 角色卡片 ——
function CharactersCard({ characters, onChange }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({ id: '', name: '', role: '', description: '', notes: '' });

  function startAdd() { setEditing({ id: '', name: '', role: '', description: '', notes: '' }); setDraft({ id: '', name: '', role: '', description: '', notes: '' }); }
  function startEdit(c) { setEditing({ ...c }); setDraft({ ...c }); }
  function cancel() { setEditing(null); }
  function save() {
    if (!editing) return;
    if (!draft.name?.trim() && !draft.role?.trim() && !draft.description?.trim()) return cancel();
    const arr = draft.id ? characters.map((c) => (c.id === draft.id ? { ...c, ...draft } : c)) : [...characters, { ...draft }];
    onChange(arr);
    setEditing(null);
  }
  function remove(id) { onChange(characters.filter((c) => c.id !== id)); }

  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between mb-3">
          <span className="font-medium">角色 {characters.length}</span>
          <Button size="sm" variant="flat" onPress={startAdd} isDisabled={!!editing}>＋ 添加</Button>
        </div>
        {editing ? (
          <div className="flex flex-col gap-2 bg-default-100 rounded-lg p-3 mb-3">
            <Input label="名字" size="sm" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <Input label="定位" size="sm" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} placeholder="主角/反派/朋友..." />
            <Textarea label="描述" rows={3} size="sm" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="性格/背景/目标/关系..." />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="flat" onPress={cancel}>取消</Button>
              <Button size="sm" color="primary" onPress={save}>保存</Button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          {characters.length === 0 && !editing ? (
            <div className="text-center text-default-400 text-xs py-4 border border-dashed border-default-200 rounded-lg">还没有角色</div>
          ) : characters.map((c) => (
            <div key={c.id || c.name} className="border border-default-200 rounded-lg p-3 bg-default-50">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium truncate">{c.name}</span>
                  {c.role ? <Chip size="sm" variant="bordered">{c.role}</Chip> : null}
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="flat" isIconOnly onPress={() => startEdit(c)}>✎</Button>
                  <Button size="sm" variant="flat" isIconOnly onPress={() => remove(c.id)}>🗑</Button>
                </div>
              </div>
              {c.description ? <p className="text-xs text-default-600 mt-1.5 whitespace-pre-wrap">{c.description}</p> : null}
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

// —— 记忆卡片 ——
function MemoryCard({ memory, onChange }) {
  const [editing, setEditing] = useState(null);
  const [content, setContent] = useState('');

  function startAdd() {
    const n = prompt('文件名（如 设定.md）：');
    if (!n) return;
    setEditing({ name: n, content: '' });
    setContent('');
  }
  function startEdit(m) { setEditing(m); setContent(m.content || ''); }
  function save() {
    if (!editing) return;
    const existing = memory.find((m) => m.name === editing.name);
    const next = existing
      ? memory.map((m) => (m.name === editing.name ? { name: editing.name, content } : m))
      : [...memory, { name: editing.name, content }];
    onChange(next);
    setEditing(null);
  }
  function remove(name) { onChange(memory.filter((m) => m.name !== name)); }

  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between mb-3">
          <span className="font-medium">记忆 {memory.length}</span>
          <Button size="sm" variant="flat" onPress={startAdd} isDisabled={!!editing}>＋ 新文件</Button>
        </div>
        {editing ? (
          <div className="flex flex-col gap-2 bg-default-100 rounded-lg p-3 mb-3">
            <div className="text-xs text-default-500">{editing.name}</div>
            <Textarea rows={8} size="sm" value={content} onChange={(e) => setContent(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="flat" onPress={() => setEditing(null)}>取消</Button>
              <Button size="sm" color="primary" onPress={save}>保存</Button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          {memory.length === 0 ? (
            <div className="text-center text-default-400 text-xs py-4 border border-dashed border-default-200 rounded-lg">设定 · 伏笔 · 剧情进展</div>
          ) : memory.map((m) => (
            <div key={m.name} className="flex items-center justify-between border border-default-200 rounded-lg px-3 py-1.5 hover:border-primary transition-colors">
              <button className="text-left text-xs flex-1" onClick={() => startEdit(m)}>{m.name}{!m.content ? <span className="text-default-400 ml-2">（空）</span> : null}</button>
              <Button size="sm" variant="flat" isIconOnly onPress={() => remove(m.name)}>🗑</Button>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

// —— 新建小说弹窗 ——
function NewNovelModal({ open, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [idea, setIdea] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (open) { setName(''); setIdea(''); }
  }, [open]);

  async function submit() {
    if (!name.trim()) { toast.error('请填写小说标题'); return; }
    setSubmitting(true);
    try {
      const p = await api.post('/api/projects', { name: name.trim(), type: 'novel', idea: idea.trim() });
      onCreate(p);
      onClose();
    } catch (e) {
      toast.error(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal isOpen={open} onClose={onClose}>
      <ModalContent>
        <ModalHeader>新建小说</ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-3">
            <Input label="小说标题" value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：凡人修仙传" />
            <Textarea label="中心思想 / 故事梗概" rows={4} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="主角是谁、想做什么、遇到什么障碍、卖点是什么……一两段即可" />
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose}>取消</Button>
          <Button color="primary" onPress={submit} isLoading={submitting} isDisabled={!name.trim()}>创建</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
