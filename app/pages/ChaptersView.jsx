'use client';
import { useEffect, useState, useCallback } from 'react';
import { Button, Input, Card, CardBody, Textarea, Chip, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from '@heroui/react';
import { api } from '../api-client.js';
import ReferencePicker from './ReferencePicker';
import ChapterOps from './ChapterOps';
import LoadingOverlay from './LoadingOverlay';
import { fileUrl, statusColor } from './shared';
import { useToast } from '../toast';

// 拖拽手柄图标（6 点 grip）
function GripIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="5" r="1.7" />
      <circle cx="16" cy="5" r="1.7" />
      <circle cx="8" cy="12" r="1.7" />
      <circle cx="16" cy="12" r="1.7" />
      <circle cx="8" cy="19" r="1.7" />
      <circle cx="16" cy="19" r="1.7" />
    </svg>
  );
}

// ============ 章节管理（合并原「章节管理」+「生成内容」） ============
export default function ChaptersView({ projectId, chapters, onRefresh, running, runningChapter, onRun, onStop, onGoLogs }) {
  const toast = useToast();
  // 本地顺序副本：拖拽排序时即时更新，drop 后再写回后端 seq
  const [order, setOrder] = useState(chapters);
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  // 新建/编辑章节共用一个弹窗：creating=true 表示新建，editing 非空表示编辑
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editNovel, setEditNovel] = useState('');
  const [editDirty, setEditDirty] = useState(false);
  // 保存/删除等耗时操作进行中：显示全屏加载层并阻断重复点击
  const [busy, setBusy] = useState(null);
  const [vision, setVision] = useState(false);
  const [refs, setRefs] = useState([]);
  const [savedRefs, setSavedRefs] = useState([]);
  // 操作弹窗
  const [operating, setOperating] = useState(null);
  // 播放成片弹窗：{ title, url }
  const [playing, setPlaying] = useState(null);
  // 正在提交生成的章节标题：提交到「任务真正开始（runningChapter 更新）」之间的加载态
  const [submitting, setSubmitting] = useState(null);
  // 正在停止的加载态：点击「停止」到「任务真正停下（running 消失）」之间的转圈
  const [stopping, setStopping] = useState(false);

  useEffect(() => { setOrder(chapters); }, [chapters]);
  useEffect(() => { api.get('/api/config').then((c) => setVision(!!c?.llm?.vision)).catch(() => {}); }, []);
  const loadRefs = useCallback(() => {
    api.get('/api/projects/' + projectId + '/references').then(setSavedRefs).catch(alert);
  }, [projectId]);
  useEffect(() => { loadRefs(); }, [loadRefs]);

  // 一旦有任务真正跑起来，就结束提交加载态：
  // 要么是本章任务开始 → 按钮转「停止」；要么是别的章节在跑（提交被 409 拒绝）→ 恢复「生成」。
  // 判据同时看 running（项目里已有活动任务）与 runningChapter（其中带章节的那个）：
  // 任务可能先落在「排队中」，此时 runningChapter 还是 null。
  useEffect(() => {
    if (submitting && (running || runningChapter)) setSubmitting(null);
  }, [running, runningChapter, submitting]);

  // 停止请求发出后，等任务真正停下（running 变 false）再清除停止加载态。
  useEffect(() => {
    if (stopping && !running) setStopping(false);
  }, [running, stopping]);

  // 参考素材按章节归属：仅展示当前编辑章节（chapter_id = editing.id）的参考素材；新建时无已保存素材
  const chapterRefs = editing ? savedRefs.filter((r) => r.chapter_id === editing.id) : [];

  function openCreate() {
    setCreating(true);
    setEditTitle('');
    setEditNovel('');
    setEditDirty(false);
    setRefs([]);
  }
  function openEdit(c) {
    setEditing(c);
    setEditTitle(c.title || '');
    setEditNovel(c.novel || '');
    setEditDirty(false);
    setRefs([]);
  }

  // 新建/编辑统一入口：先保存章节（新建 POST / 编辑 PATCH），再上传待上传的参考素材。
  // 参考素材上传失败不会丢章节：章节已保存成功时提示「章节已保存，但部分参考素材…」，弹窗保持打开以便修正。
  async function saveChapter() {
    const isNew = !!creating;
    if (!isNew && !editing) return;
    setBusy(isNew ? '正在创建章节…' : '正在保存章节…');
    try {
      let cid = editing ? editing.id : null;
      if (isNew) {
        // 标题留空交给后端自动命名（第N章）；显式传空标题会被 pickChapterFields 拒绝
        const payload = { novel: editNovel };
        if ((editTitle || '').trim()) payload.title = editTitle.trim();
        const c = await api.post('/api/projects/' + projectId + '/chapters', payload);
        cid = c.id;
      } else {
        await api.patch('/api/projects/' + projectId + '/chapters/' + cid, { title: editTitle, novel: editNovel });
      }
      if (refs.length && cid) await uploadRefs(cid);
      toast.success(isNew ? '已创建章节' : '已保存「' + editTitle + '」');
      setCreating(false);
      setEditing(null);
      setEditDirty(false);
      onRefresh();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }
  async function runAll() {
    await submitRun(null);
  }
  // 「生成/继续」的唯一入口：onRun（ProjectView.run）会把失败抛出来，这里统一提示，
  // 成功才由各按钮自己继续（旧写法 onRun 吞掉错误 + 调用方照弹「已提交」= 假成功提示）。
  // 提交期间进入加载态：任务真正跑起来（running / runningChapter 更新）后由上面的 useEffect 清除；
  // 提交失败则在这里当场清除，避免按钮永远转圈。
  async function submitRun(title) {
    setSubmitting(title);
    try { await onRun(title); } catch (e) { toast.error(e.message); setSubmitting(null); }
  }
  async function handleStop() {
    setStopping(true);
    try { await onStop(); } catch (e) { toast.error(e.message); setStopping(false); }
  }
  async function removeChapter(c) {
    if (!(await toast.confirm('删除「' + c.title + '」及其分镜？此操作不可逆。', { danger: true }))) return;
    setBusy('正在删除章节…');
    try { await api.del('/api/projects/' + projectId + '/chapters/' + c.id); toast.success('已删除「' + c.title + '」'); onRefresh(); } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }

  // 上传本章参考素材到指定章节：逐条上传、成功一条就从待上传列表里摘掉。
  // 此前一条失败会把**已经传成功的**也留在列表里，用户再点一次就重复上传（素材库里多出重复参考图）；
  // 报错也没说是哪个文件。这里返回成功张数，失败时抛出（含已成功张数的提示）。
  async function uploadRefs(chapterId) {
    let done = 0;
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
        const why = j.error || ('上传失败 HTTP ' + res.status);
        throw new Error('「' + (it.file.name || '参考图') + '」' + why + (done ? '；前 ' + done + ' 张已上传成功，可直接继续传剩下的' : ''));
      }
      done += 1;
      // 按 key 精确移除（同名文件也不会误删别的待上传项）
      setRefs((prev) => prev.filter((x) => x.key !== it.key));
    }
    loadRefs();
    return done;
  }
  async function delRef(rid) {
    setEditDirty(true);
    try { await api.del('/api/projects/' + projectId + '/references/' + rid); loadRefs(); } catch (e) { alert(e.message); }
  }
  async function updateRef(rid, patch) {
    // 乐观更新，失败回滚重载；编辑参考素材也算「有改动」，让「保存本章」按钮可点（确认后关闭弹窗）
    setEditDirty(true);
    setSavedRefs((prev) => prev.map((r) => (r.id === rid ? { ...r, ...patch } : r)));
    try {
      await api.patch('/api/projects/' + projectId + '/references/' + rid, patch);
    } catch (e) { alert(e.message); loadRefs(); }
  }

  // 拖拽排序：本地立即重排，drop 后把新顺序写回后端 seq
  async function persistReorder(list) {
    try {
      await api.patch('/api/projects/' + projectId + '/chapters', { ids: list.map((c) => c.id) });
      onRefresh();
    } catch (e) {
      toast.error(e.message);
      onRefresh();
    }
  }
  function handleDrop(to) {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    persistReorder(next);
  }

  const label = { empty: '无分镜', pending: '待生成', running: '生成中', done: '完成', failed: '失败' };
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardBody className="gap-4">
          <div className="row justify-between">
            <h2 className="text-lg font-semibold m-0">章节管理</h2>
            <div className="row" style={{ gap: 8 }}>
              <Button color="primary" size="sm" onPress={openCreate}>＋ 新增章节</Button>
              <Button size="sm" variant="flat" isDisabled={running || !chapters.length} onPress={runAll}>▶ 生成全部章节</Button>
            </div>
          </div>
          <p className="muted" style={{ margin: 0 }}>先规划整本书的章节骨架，再逐章生成。素材库为全项目共用，分镜在「分镜审查」页查看。</p>

          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
            {order.map((c, i) => (
              <div
                key={c.id}
                className="group relative"
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overIndex !== i) setOverIndex(i); }}
                onDrop={() => handleDrop(i)}
              >
                <Card className={overIndex === i && dragIndex !== null && dragIndex !== i ? 'ring-2 ring-primary/60' : ''}>
                  <CardBody className="gap-3 p-4">
                    <div className="relative">
                      {c.poster
                        ? (
                          <>
                            <img
                              src={fileUrl(projectId, c.poster)}
                              alt={c.title}
                              style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 10, cursor: (c.genStatus === 'done' && c.video) ? 'pointer' : 'default' }}
                              onClick={() => { if (c.genStatus === 'done' && c.video) setPlaying({ title: c.title, url: c.video }); }}
                            />
                            {/* 完成且有成片时：居中播放角标提示可点击预览图播放最新成片 */}
                            {c.genStatus === 'done' && c.video && (
                              <div className="absolute inset-0 flex items-center justify-center" style={{ pointerEvents: 'none' }}>
                                <span className="flex items-center justify-center" style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 16 }}>▶</span>
                              </div>
                            )}
                          </>
                        )
                        : <div className="muted bg-default-100" style={{ width: '100%', aspectRatio: '16 / 9', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10 }}>暂无预览</div>}
                      {/* 右上角关闭图标（删除） */}
                      <Button
                        isIconOnly
                        size="sm"
                        color="danger"
                        variant="flat"
                        className="absolute top-2 right-2 z-10"
                        onPress={() => removeChapter(c)}
                        title="删除"
                      >✕</Button>
                      {/* 左上角拖拽手柄：悬浮卡片时显示 */}
                      <button
                        type="button"
                        draggable
                        onDragStart={(e) => { setDragIndex(i); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch {} }}
                        onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                        className="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing bg-black/40 text-white rounded-md p-1.5"
                        title="拖拽排序"
                      ><GripIcon /></button>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <b className="text-base" style={{ wordBreak: 'break-all' }}>{c.title}</b>
                      <Chip size="sm" variant="flat" color={statusColor(c.genStatus)}>{label[c.genStatus] || c.status}{c.shotCount > 0 ? ' · ' + c.doneCount + '/' + c.shotCount : ''}</Chip>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        color={runningChapter === c.title ? 'danger' : 'success'}
                        variant="flat"
                        className="flex-1"
                        isLoading={(submitting === c.title && runningChapter !== c.title) || (runningChapter === c.title && stopping)}
                        isDisabled={(running && runningChapter !== c.title) || (runningChapter === c.title && stopping)}
                        onPress={() => (runningChapter === c.title ? handleStop() : submitRun(c.title))}
                      >
                        {runningChapter === c.title ? '■ 停止' : '▶ 生成'}
                      </Button>
                      <Button size="sm" color="primary" variant="flat" className="flex-1" onPress={() => openEdit(c)}>编辑</Button>
                      <Button size="sm" color="primary" variant="flat" className="flex-1" onPress={() => setOperating(c)}>操作</Button>
                    </div>
                  </CardBody>
                </Card>
              </div>
            ))}
          </div>
          {!chapters.length && <p className="muted">还没有章节，点「＋ 新增章节」。</p>}
        </CardBody>
      </Card>

      {/* 新建 / 编辑章节弹窗 */}
      <Modal isOpen={creating || !!editing} size="2xl" backdrop="blur" onClose={() => { if (!busy) { setCreating(false); setEditing(null); } }}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="pb-2">
                <h2 className="m-0 text-lg font-semibold">{creating ? '新建章节' : '编辑章节' + (editing ? ' · ' + editing.title : '')}</h2>
              </ModalHeader>
              <ModalBody>
                <div className="flex flex-col gap-3">
                  <Input size="sm" label="章节标题" value={editTitle} onChange={(e) => { setEditTitle(e.target.value); setEditDirty(true); }} placeholder={creating ? '留空自动命名为「第N章」' : '章节标题'} />
                  <div>
                    <h3 className="text-sm m-0" style={{ marginBottom: 6 }}>本章小说原文</h3>
                    <Textarea size="sm" minRows={6} value={editNovel} onChange={(e) => { setEditNovel(e.target.value); setEditDirty(true); }} placeholder="粘贴或编辑本章原文…" />
                  </div>
                  <ReferencePicker
                    projectId={projectId}
                    items={refs}
                    onChange={setRefs}
                    saved={chapterRefs}
                    onUpdateSaved={updateRef}
                    onDeleteSaved={delRef}
                    allowAdd={vision}
                  />
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" isDisabled={!!busy} onPress={() => { setCreating(false); setEditing(null); }}>取消</Button>
                <Button color="primary" isLoading={!!busy} isDisabled={creating ? false : (!editDirty && !refs.length)} onPress={saveChapter}>保存本章</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* 生成操作弹窗 */}
      <Modal isOpen={!!operating} size="2xl" backdrop="blur" onClose={() => setOperating(null)}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="pb-2"><h2 className="m-0 text-lg font-semibold">生成操作{operating ? ' · ' + operating.title : ''}</h2></ModalHeader>
              <ModalBody>
                {operating && <ChapterOps projectId={projectId} chapter={operating} running={running} runningChapter={runningChapter} onRun={onRun} onStop={onStop} onRefresh={onRefresh} onGoLogs={onGoLogs} />}
              </ModalBody>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* 播放成片弹窗 */}
      <Modal isOpen={!!playing} size="3xl" backdrop="blur" onClose={() => setPlaying(null)}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="pb-2"><h2 className="m-0 text-lg font-semibold">播放成片{playing ? ' · ' + playing.title : ''}</h2></ModalHeader>
              <ModalBody>
                {playing && <video className="video" controls autoPlay src={playing.url} style={{ width: '100%', maxHeight: '70vh', borderRadius: 8 }} />}
              </ModalBody>
            </>
          )}
        </ModalContent>
      </Modal>

      <LoadingOverlay show={!!busy} text={busy} />
    </div>
  );
}
