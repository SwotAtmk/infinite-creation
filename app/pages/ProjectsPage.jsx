'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { Button, Input, Select, SelectItem, Card, CardBody, Textarea, Chip, Spinner, Switch, Checkbox, Tooltip } from '@heroui/react';
import { api } from '../api-client.js';
import { STYLE_OPTIONS, STYLE_CUSTOM, resolveStyle, selectKeys, pickKey, statusColor, fileUrl, VIDEO_RESOLUTIONS, VIDEO_RATIOS } from './shared';
import ReferencePicker from './ReferencePicker';
import LoadingOverlay from './LoadingOverlay';
import { useToast } from '../toast';

// 删除（垃圾桶）图标
function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

// 勾选图标（用于卡片左上角的选择按钮）
function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ============ 项目列表 ============
const PAGE_SIZE = 10;

export default function ProjectsPage({ onOpen }) {
  const toast = useToast();
  const [projects, setProjects] = useState([]);
  // 首次加载标记：数据回来之前不要显示「暂无项目」，否则用户会误以为项目丢了
  const [loading, setLoading] = useState(true);
  // 瀑布流分页：hasMore 决定是否还有下一页，loadingMore 防止滚动时重复请求
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useRef(1);
  const sentinelRef = useRef(null);
  const novelFileRef = useRef(null);
  const [form, setForm] = useState({ name: '', novel: '', style: '' });
  // 上传 txt 解析出的全文（不在输入框预览，创建项目时作为 novel 来源）
  const [uploadedNovel, setUploadedNovel] = useState(null);
  // textarea 是否聚焦：聚焦时隐藏自定义 placeholder（含上传按钮），让用户正常输入
  const [novelFocused, setNovelFocused] = useState(false);
  const [customStyle, setCustomStyle] = useState('');
  const [vision, setVision] = useState(false);
  const [refs, setRefs] = useState([]);
  // 视频参数（新建项目时设置，默认与后端一致）
  const [res, setRes] = useState('480P');
  const [ratio, setRatio] = useState('16:9');
  const [cw, setCw] = useState('');
  const [ch, setCh] = useState('');
  const [enableBgm, setEnableBgm] = useState(true);
  // 创建项目进行中：显示全屏加载层提示等待并阻断重复点击
  const [busy, setBusy] = useState(null);
  // 批量删除：已勾选的项目 id（只针对当前已加载的列表）
  const [selected, setSelected] = useState(() => new Set());
  const allSelected = projects.length > 0 && selected.size === projects.length;

  const load = useCallback(() => {
    setLoading(true);
    pageRef.current = 1;
    setSelected(new Set());
    return api.get('/api/projects?page=1&pageSize=' + PAGE_SIZE)
      .then((r) => {
        setProjects(r.items || []);
        setHasMore(!!r.hasMore);
      })
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []);
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const next = pageRef.current + 1;
    return api.get('/api/projects?page=' + next + '&pageSize=' + PAGE_SIZE)
      .then((r) => {
        pageRef.current = next;
        setProjects((prev) => [...prev, ...(r.items || [])]);
        setHasMore(!!r.hasMore);
      })
      .catch((e) => toast.error(e.message))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/api/config').then((c) => setVision(!!c?.llm?.vision)).catch(() => {}); }, []);

  // 滚动到底部（哨兵元素进入视口）时加载下一页
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // 上传参考图：拆成多章时 shared=true，参考图标记为「共享」供所有章节使用
  async function uploadReferences(projectId, chapterId, shared) {
    for (const it of refs) {
      const fd = new FormData();
      fd.append('file', it.file);
      fd.append('mode', it.mode);
      fd.append('category', it.category || 'other');
      fd.append('chapter_id', chapterId);
      fd.append('description', it.description || '');
      if (shared) fd.append('shared', '1');
      const res = await fetch('/api/projects/' + projectId + '/references', { method: 'POST', body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || ('参考图上传失败 HTTP ' + res.status));
      }
    }
  }

  // 上传 .txt 小说文件到后端解析（不本地预览），解析结果用于创建项目
  async function uploadNovelFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/novel/parse', { method: 'POST', body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || ('解析失败 HTTP ' + res.status));
      setUploadedNovel({ name: file.name, novel: j.novel || '', chars: j.chars || 0, chapterCount: j.chapterCount || 0 });
    } catch (err) {
      toast.error('上传小说失败：' + (err.message || err));
    }
  }

  async function create() {
    setBusy('正在创建项目…');
    try {
      const style = resolveStyle(form.style, customStyle);
      const novel = uploadedNovel ? uploadedNovel.novel : form.novel;
      const p = await api.post('/api/projects', {
        ...form,
        novel,
        style,
        video_resolution: res,
        video_aspect_ratio: ratio,
        video_width: Number(cw) || 0,
        video_height: Number(ch) || 0,
        enable_bgm: enableBgm,
      });
      // 项目已经落库（POST 成功）：后面的取章节 / 传参考图失败，不能让用户以为「创建失败」——
      // 此前这类失败只弹一条 toast，列表不刷新、也不进项目，用户会再点一次「创建并打开」，
      // 于是同一个项目建了两遍（Projects.create 不限制重名）。先刷新列表，再单独兜参考图这一步。
      load();
      try {
        if (refs.length) {
          const chapters = await api.get('/api/projects/' + p.id + '/chapters');
          await uploadReferences(p.id, (chapters[0] && chapters[0].id) || '', chapters.length > 1);
        }
      } catch (e) {
        toast.error('项目已创建，但参考图上传失败：' + e.message + '（可在章节页重新上传）');
      }
      onOpen(p.id);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }
  async function del(id) {
    if (!(await toast.confirm('删除该项目及其所有素材？', { danger: true }))) return;
    setBusy('正在删除项目…');
    try { await api.del('/api/projects/' + id); toast.success('已删除'); load(); } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }
  function toggleOne(id, checked) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }
  function toggleAll(checked) {
    setSelected(checked ? new Set(projects.map((p) => p.id)) : new Set());
  }
  async function batchDelete() {
    const ids = projects.filter((p) => selected.has(p.id)).map((p) => p.id);
    if (!ids.length) return;
    if (!(await toast.confirm('删除选中的 ' + ids.length + ' 个项目及其所有素材？', { danger: true }))) return;
    // 逐个删除：单个删除接口里已包含「停任务 + 删库 + 删目录」，批量不需要另开一套后端逻辑。
    // 某一个失败不影响其余，最后统一汇报失败项。
    const failed = [];
    for (let i = 0; i < ids.length; i++) {
      setBusy('正在删除项目 ' + (i + 1) + '/' + ids.length + '…');
      try { await api.del('/api/projects/' + ids[i]); } catch (e) { failed.push((e.message || '未知错误')); }
    }
    setBusy(null);
    if (failed.length) toast.error('有 ' + failed.length + ' 个项目删除失败：' + failed.join('；'));
    else toast.success('已删除 ' + ids.length + ' 个项目');
    load();
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
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Textarea
                size="sm"
                placeholder=""
                value={form.novel}
                onChange={(e) => { setForm({ ...form, novel: e.target.value }); if (uploadedNovel) setUploadedNovel(null); }}
                onFocus={() => { setNovelFocused(true); if (uploadedNovel) setUploadedNovel(null); }}
                onBlur={() => setNovelFocused(false)}
              />
              {uploadedNovel ? (
                <div className="absolute inset-0 flex items-center gap-2 px-2 py-2 text-small pointer-events-none">
                  <span className="text-foreground-500">已上传「{uploadedNovel.name}」（约 {uploadedNovel.chars} 字，将拆分为 {uploadedNovel.chapterCount} 章）</span>
                  <button
                    type="button"
                    onClick={() => novelFileRef.current && novelFileRef.current.click()}
                    className="pointer-events-auto text-primary hover:underline bg-transparent border-0 p-0 cursor-pointer"
                  >更换</button>
                  <button
                    type="button"
                    onClick={() => setUploadedNovel(null)}
                    className="pointer-events-auto text-primary hover:underline bg-transparent border-0 p-0 cursor-pointer"
                  >取消</button>
                </div>
              ) : (!form.novel && !novelFocused) ? (
                <div className="absolute inset-0 flex items-start gap-1 px-2 py-2 text-small pointer-events-none">
                  <span className="text-foreground-500">粘贴小说原文或一句话描述故事，或者</span>
                  <button
                    type="button"
                    onClick={() => novelFileRef.current && novelFileRef.current.click()}
                    className="pointer-events-auto text-primary hover:underline bg-transparent border-0 p-0 cursor-pointer inline-flex items-center"
                  >
                    上传txt文本文件
                    <Tooltip
                      content="自动识别章节标题（如「第一章 / 第1章 / Chapter 1」）拆分；无标题且超长时按约 6000 字/章均分"
                      placement="top"
                    >
                      <span className="inline-flex items-center ml-1">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
                        </svg>
                      </span>
                    </Tooltip>
                  </button>
                </div>
              ) : null}
            </div>
            <input ref={novelFileRef} type="file" accept=".txt,text/plain" style={{ display: 'none' }} onChange={uploadNovelFile} />
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span className="muted">分辨率</span>
            <Select size="sm" className="w-36" aria-label="分辨率" selectedKeys={selectKeys(res)} onSelectionChange={(k) => setRes(pickKey(k))}>
              {VIDEO_RESOLUTIONS.map(([v, l]) => <SelectItem key={v}>{l}</SelectItem>)}
            </Select>
            <span className="muted">比例</span>
            <Select size="sm" className="w-28" aria-label="比例" selectedKeys={selectKeys(ratio)} onSelectionChange={(k) => setRatio(pickKey(k))}>
              {VIDEO_RATIOS.map((r) => <SelectItem key={r}>{r}</SelectItem>)}
            </Select>
            {res === 'custom' && (
              <>
                <span className="muted">宽</span>
                <Input size="sm" type="number" min="64" step="32" value={cw} onChange={(e) => setCw(e.target.value)} placeholder="1024" className="w-24" />
                <span className="muted">高</span>
                <Input size="sm" type="number" min="64" step="32" value={ch} onChange={(e) => setCh(e.target.value)} placeholder="576" className="w-24" />
              </>
            )}
          </div>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <Switch size="sm" isSelected={enableBgm} onValueChange={setEnableBgm}>生成背景音乐</Switch>
            <span className="muted" style={{ fontSize: 12 }}>开启后，视频阶段会自动生成纯音乐背景音乐并合成到成片。</span>
          </div>
          {vision && <ReferencePicker items={refs} onChange={setRefs} />}
          <div>
            <Button color="primary" isDisabled={!form.name || (!uploadedNovel && !form.novel.trim())} onPress={create}>创建并打开</Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="gap-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-lg font-semibold m-0">项目列表</h2>
            {!loading && projects.length > 0 && (
              <div className="flex items-center gap-3">
                <Checkbox size="sm" isSelected={allSelected} onValueChange={toggleAll}>全选</Checkbox>
                <Button
                  size="sm"
                  color="danger"
                  variant="flat"
                  isDisabled={!selected.size}
                  onPress={batchDelete}
                >批量删除{selected.size ? '（' + selected.size + '）' : ''}</Button>
              </div>
            )}
          </div>
          {loading && (
            <div className="flex items-center justify-center gap-2.5 py-6">
              <Spinner size="sm" />
              <span className="muted">项目加载中…</span>
            </div>
          )}
          {!loading && (
            // 卡片高度一致（16:9 预览 + 单行信息），用行优先的 grid 排布：
            // CSS columns 是「先填满一列再填下一列」，10 条会摊成 3/3/2/2 列，末尾两行留空；
            // grid 按从左到右、从上到下铺满，只有最后一行的剩余位置是空的。
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
              {projects.map((p) => (
                <div key={p.id} className={'border rounded-xl overflow-hidden flex flex-col bg-default-50 hover:shadow-md transition-shadow ' + (selected.has(p.id) ? 'border-primary ring-1 ring-primary' : 'border-default-200')}>
                  <div className="relative">
                    <button onClick={() => onOpen(p.id)} className="block w-full p-0 bg-transparent border-0 cursor-pointer">
                      {p.poster
                        ? <img src={fileUrl(p.id, p.poster)} alt={p.name} className="w-full aspect-video object-cover bg-black" />
                        : <div className="w-full aspect-video bg-default-200 flex items-center justify-center text-default-500 text-sm">暂无预览</div>}
                    </button>
                    {/* 自绘圆形勾选按钮：HeroUI Checkbox 自带 p-2 -m-2 且为方形，
                        套在浮层里左右/上下留白不一致，看起来不居中；这里用固定 24px 圆点保证对称 */}
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={selected.has(p.id)}
                      aria-label={'选择 ' + p.name}
                      onClick={(e) => { e.stopPropagation(); toggleOne(p.id, !selected.has(p.id)); }}
                      className={'absolute top-2 left-2 z-10 w-6 h-6 p-0 rounded-full border-2 flex items-center justify-center transition-colors cursor-pointer ' + (selected.has(p.id)
                        ? 'bg-primary border-primary text-primary-foreground shadow-sm'
                        : 'bg-transparent border-white/90 text-transparent hover:bg-white/25')}
                    ><CheckIcon /></button>
                    <Button
                      isIconOnly
                      size="sm"
                      color="danger"
                      variant="flat"
                      className="absolute top-2 right-2 z-10"
                      onPress={() => del(p.id)}
                      title="删除"
                    ><TrashIcon /></Button>
                  </div>
                  <div className="flex flex-col gap-2 p-3">
                    <button onClick={() => onOpen(p.id)} className="bg-transparent border-0 p-0 text-left text-[15px] font-medium cursor-pointer text-foreground truncate">{p.name}</button>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="muted">资产 {p.assetCount} · 分镜 {p.shotCount}</span>
                      <Chip size="sm" variant="flat" color={statusColor(p.status)}>{p.status || 'idle'}</Chip>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!loading && !projects.length && <p className="muted">暂无项目</p>}
          <div ref={sentinelRef} className="flex items-center justify-center gap-2 py-3">
            {loadingMore && <Spinner size="sm" />}
            {!loading && hasMore && <span className="muted">{loadingMore ? '加载中…' : '向下滚动加载更多'}</span>}
            {!loading && !hasMore && projects.length > 0 && <span className="muted">已经到底啦，没有更多项目了</span>}
          </div>
        </CardBody>
      </Card>
      <LoadingOverlay show={!!busy} text={busy} />
    </div>
  );
}
