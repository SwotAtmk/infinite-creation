'use client';
import { useEffect, useState, useCallback } from 'react';
import { Button, Input, Card, CardBody, Chip, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { fileUrl, dialogueSpeakers, statusColor } from './shared';
import { useToast } from '../toast';
import ShotMaterialPicker from './ShotMaterialPicker';
import LoadingOverlay from './LoadingOverlay';

const MATERIAL_FIELD = { character: 'character_ids', scene: 'scene_ids', prop: 'prop_ids', costume: 'costume_ids', age: 'age_ids', audio: 'audio_ids' };

// ============ 分镜审查 ============
export default function ShotsTab({ projectId, chapter: chapterProp = '', running = false, jobs = [], onRefresh }) {
  const toast = useToast();
  const [shots, setShots] = useState([]);
  const [assets, setAssets] = useState([]);
  const [project, setProject] = useState(null);
  const [preview, setPreview] = useState(null);
  const [feedback, setFeedback] = useState({});
  const [zipping, setZipping] = useState(false);
  // 有反馈=需要 LLM：弹窗问「LLM 改写后是否还要渲染视频」
  const [ask, setAsk] = useState(null);
  const [loading, setLoading] = useState(true);
  const [materialPicker, setMaterialPicker] = useState(null);
  // 导出/打包等耗时操作进行中：显示全屏加载层提示等待并阻断重复点击，操作结束后自动消失
  const [busy, setBusy] = useState(null);
  const load = useCallback(() => {
    return Promise.all([
      api.get('/api/projects/' + projectId + '/shots').then(setShots).catch((e) => toast.error(e.message)),
      api.get('/api/projects/' + projectId + '/assets').then(setAssets).catch((e) => toast.error(e.message)),
      api.get('/api/projects/' + projectId).then(setProject).catch(() => {}),
    ]);
  }, [projectId]);
  // 生成期间定时拉取，实时反映每个分镜的生成结果（Agent 逐镜写库，没有逐镜的 WS 事件）
  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);
  const shown = chapterProp ? shots.filter((s) => (s.chapter || '默认') === chapterProp) : shots;
  const doneShots = shown.filter((s) => s.video_path && s.status === 'done');

  const byId = (id) => assets.find((a) => a.id === id);
  // 该分镜是否有正在执行/排队的任务（按 job.checkpoint.subject 关联），用于按钮显示与禁用
  const activeJobFor = (subject) => jobs.find((j) => (j.status === 'running' || j.status === 'queued') && j.checkpoint && j.checkpoint.subject === subject);
  const asArr = (v) => Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } })() : []);
  const charsOf = (s) => asArr(s.character_ids).map(byId).filter(Boolean);
  const scenesOf = (s) => asArr(s.scene_ids).map(byId).filter(Boolean);
  const propsOf = (s) => asArr(s.prop_ids).map(byId).filter(Boolean);
  const costumesOf = (s) => asArr(s.costume_ids).map(byId).filter(Boolean);
  const agesOf = (s) => asArr(s.age_ids).map(byId).filter(Boolean);
  const audiosOf = (s) => asArr(s.audio_ids).map(byId).filter(Boolean);

  function RefThumb({ a, onReplace, onRemove }) {
    return (
      <div style={{ textAlign: 'center', width: 88 }}>
        {a.image_path
          ? <img className="thumb" src={fileUrl(projectId, a.image_path)} onClick={() => setPreview(a)} style={{ width: 64, height: 64, objectFit: 'cover', cursor: 'zoom-in' }} title="点击预览" />
          : <div className="thumb" style={{ width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto', aspectRatio: '1 / 1' }}>{a.category}</div>}
        <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{a.name}</div>
        {(onReplace || onRemove) && (
          <div className="row" style={{ justifyContent: 'center', gap: 4, marginTop: 2 }}>
            {onReplace && <Button size="sm" variant="light" className="h-6 min-w-0 px-1.5 text-[10px]" onPress={onReplace}>替换</Button>}
            {onRemove && <Button size="sm" variant="light" className="h-6 min-w-0 px-1.5 text-[10px]" onPress={onRemove}>×</Button>}
          </div>
        )}
      </div>
    );
  }

  async function regen(shotId, render = true) {
    const fb = (feedback[shotId] || '').trim();
    try {
      await api.post('/api/projects/' + projectId + '/shots/' + shotId + '/regenerate', { feedback: fb || undefined, render });
      toast.success(render ? '已提交重生成' : '已提交：仅 LLM 改写提示词，不渲染视频');
      load();
      onRefresh && onRefresh();
    } catch (e) { toast.error(e.message); }
  }
  // 左侧反馈框有值 → 需要 LLM，弹窗确认；留空 → 直接渲染视频
  function onRegen(shotId) {
    if ((feedback[shotId] || '').trim()) setAsk(shotId);
    else regen(shotId, true);
  }
  async function exportChapter() {
    setBusy('正在导出本章成片…');
    try {
      const r = await api.post('/api/projects/' + projectId + '/export', { chapter: chapterProp });
      const url = fileUrl(projectId, r.export_path);
      const a = document.createElement('a');
      a.href = url;
      a.download = (r.export_path || '').split('/').pop() || 'chapter.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success('导出成功，已开始下载。成片可到「🎞 成片」页预览和下载。');
      onRefresh();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }
  async function zipShots() {
    setZipping(true);
    setBusy('正在打包视频片段…');
    try {
      const url = '/api/projects/' + projectId + '/shots/zip' + (chapterProp ? '?chapter=' + encodeURIComponent(chapterProp) : '');
      const res = await fetch(url);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + res.status));
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      let name = '视频片段.zip';
      const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const plain = /filename="?([^";]+)"?/i.exec(cd);
      if (star) name = decodeURIComponent(star[1]);
      else if (plain) name = plain[1];
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast.error('打包失败：' + e.message); }
    finally { setZipping(false); setBusy(null); }
  }

  function openMaterial(shotId, category, mode, replaceAssetId) {
    setMaterialPicker({ shotId, category, mode, replaceAssetId });
  }
  async function applyMaterial(assetId) {
    const p = materialPicker; if (!p) return;
    const shot = shots.find((s) => s.id === p.shotId);
    const field = MATERIAL_FIELD[p.category];
    if (!shot || !field) return;
    const cur = asArr(shot[field]);
    let next;
    if (p.mode === 'replace' && p.replaceAssetId) next = cur.map((id) => (id === p.replaceAssetId ? assetId : id));
    else next = cur.includes(assetId) ? cur : [...cur, assetId];
    setMaterialPicker(null);
    try {
      await api.patch('/api/projects/' + projectId + '/shots/' + p.shotId, { [field]: next });
      toast.success('素材已更新');
      load();
    } catch (e) { toast.error(e.message); }
  }
  async function removeMaterial(shotId, category, assetId) {
    const shot = shots.find((s) => s.id === shotId);
    const field = MATERIAL_FIELD[category];
    if (!shot || !field) return;
    const next = asArr(shot[field]).filter((id) => id !== assetId);
    try {
      await api.patch('/api/projects/' + projectId + '/shots/' + shotId, { [field]: next });
      toast.success('素材已移除');
      load();
    } catch (e) { toast.error(e.message); }
  }

  if (loading) {
    return (
      <Card>
        <CardBody className="flex-row items-center justify-center gap-2.5 py-10">
          <Spinner size="sm" />
          <span className="muted">分镜数据加载中…</span>
        </CardBody>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="row justify-between">
        <h2 className="text-lg font-semibold m-0">分镜审查（{chapterProp ? chapterProp + ' · ' : ''}共 {shown.length} 镜）</h2>
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" color="primary" isDisabled={!shown.length} onPress={exportChapter}>导出本章成片</Button>
          <Button size="sm" variant="flat" isDisabled={!doneShots.length || zipping} onPress={zipShots}>{zipping ? '打包中…' : '📦 打包下载片段'}</Button>
        </div>
      </div>
      {shown.map((s) => {
        const chars = charsOf(s), scenes = scenesOf(s), props = propsOf(s), costumes = costumesOf(s), ages = agesOf(s), audios = audiosOf(s);
        // 语音参考只显示「有台词」角色（与后端 assembleShotReferences 一致）：多人同场时仅说话角色才有音色
        const speakers = dialogueSpeakers(s.dialogue);
        const speakingChars = chars.filter((c) => speakers.some((sp) => sp === c.name || sp.includes(c.name) || c.name.includes(sp)));
        const voices = speakingChars.filter((c) => c.voice_ref).map((c) => ({ name: c.name, voice_ref: c.voice_ref }));
        const allRefs = [...chars, ...scenes, ...props, ...costumes, ...ages];
        const resoLabel = s.resolution === 'custom' && project
          ? 'custom ' + (project.video_width || '?') + '×' + (project.video_height || '?')
          : (s.resolution || '480P');
        return (
          <Card key={s.id}>
            <CardBody className="gap-2">
              <div className="row justify-between">
                <b>分镜 {s.idx}{s.chapter ? ' · ' + s.chapter : ''} · {s.scene_name || '未命名'}</b>
                <Chip size="sm" variant="flat" color={statusColor(s.status)}>{s.status}</Chip>
              </div>
              <div className="muted">时长 {s.duration}s · 分辨率 {resoLabel} · 比例 {s.aspect_ratio || '16:9'} · seed {s.seed || '-'}</div>

              <div style={{ marginTop: 8 }}>
                <div className="row justify-between" style={{ alignItems: 'center', marginBottom: 4 }}>
                  <div className="muted">参考素材（角色 / 场景 / 道具 / 服装 / 年龄 / 语音〔仅台词角色〕/ 音频）</div>
                  {!running && (
                    <div className="row" style={{ gap: 4 }}>
                      <Button size="sm" variant="flat" onPress={() => openMaterial(s.id, 'character', 'add')}>＋角色</Button>
                      <Button size="sm" variant="flat" onPress={() => openMaterial(s.id, 'scene', 'add')}>＋场景</Button>
                      <Button size="sm" variant="flat" onPress={() => openMaterial(s.id, 'prop', 'add')}>＋道具</Button>
                      <Button size="sm" variant="flat" onPress={() => openMaterial(s.id, 'costume', 'add')}>＋服装</Button>
                      <Button size="sm" variant="flat" onPress={() => openMaterial(s.id, 'age', 'add')}>＋年龄</Button>
                      <Button size="sm" variant="flat" onPress={() => openMaterial(s.id, 'audio', 'add')}>＋音频</Button>
                    </div>
                  )}
                </div>
                {allRefs.length || voices.length || audios.length ? (
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    {chars.map((a) => <RefThumb key={a.id} a={a} onReplace={!running ? () => openMaterial(s.id, 'character', 'replace', a.id) : null} onRemove={!running ? () => removeMaterial(s.id, 'character', a.id) : null} />)}
                    {scenes.map((a) => <RefThumb key={a.id} a={a} onReplace={!running ? () => openMaterial(s.id, 'scene', 'replace', a.id) : null} onRemove={!running ? () => removeMaterial(s.id, 'scene', a.id) : null} />)}
                    {props.map((a) => <RefThumb key={a.id} a={a} onReplace={!running ? () => openMaterial(s.id, 'prop', 'replace', a.id) : null} onRemove={!running ? () => removeMaterial(s.id, 'prop', a.id) : null} />)}
                    {costumes.map((a) => <RefThumb key={a.id} a={a} onReplace={!running ? () => openMaterial(s.id, 'costume', 'replace', a.id) : null} onRemove={!running ? () => removeMaterial(s.id, 'costume', a.id) : null} />)}
                    {ages.map((a) => <RefThumb key={a.id} a={a} onReplace={!running ? () => openMaterial(s.id, 'age', 'replace', a.id) : null} onRemove={!running ? () => removeMaterial(s.id, 'age', a.id) : null} />)}
                    {voices.map((v, i) => (
                      <div key={i} style={{ textAlign: 'center', width: 190 }}>
                        <audio controls src={fileUrl(projectId, v.voice_ref)} style={{ width: '100%', height: 38 }} title="角色参考音色" />
                        <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{v.name}</div>
                      </div>
                    ))}
                    {audios.map((a) => (
                      <div key={a.id} style={{ textAlign: 'center', width: 190 }}>
                        {a.audio_path || a.voice_ref
                          ? <audio controls src={fileUrl(projectId, a.audio_path || a.voice_ref)} style={{ width: '100%', height: 38 }} title="音频素材（旁白音色/音乐/音效）" />
                          : <div className="muted" style={{ fontSize: 11 }}>（无音频文件）</div>}
                        <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{a.name}</div>
                        {!running && (
                          <div className="row" style={{ justifyContent: 'center', gap: 4, marginTop: 2 }}>
                            <Button size="sm" variant="light" className="h-6 min-w-0 px-1.5 text-[10px]" onPress={() => openMaterial(s.id, 'audio', 'replace', a.id)}>替换</Button>
                            <Button size="sm" variant="light" className="h-6 min-w-0 px-1.5 text-[10px]" onPress={() => removeMaterial(s.id, 'audio', a.id)}>×</Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : <span className="muted">（无）</span>}
              </div>

              <details open style={{ marginTop: 8 }}>
                <summary>提示词 & 分镜脚本</summary>
                <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                  {s.camera && <div><b>镜头：</b>{s.camera}</div>}
                  {s.visual && <div><b>画面：</b>{s.visual}</div>}
                  {s.dialogue && <div><b>台词：</b>{s.dialogue}</div>}
                  {s.narration && <div><b>旁白：</b>{s.narration}</div>}
                  {s.sub_shots && <div><b>子镜头：</b><pre style={{ whiteSpace: 'pre-wrap' }}>{s.sub_shots}</pre></div>}
                </div>
                <div style={{ marginTop: 6 }}>
                  <b>视频提示词：</b>
                  <pre className="logbox" style={{ maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{s.video_prompt || '（未生成）'}</pre>
                </div>
                {s.prompt_id && <div className="muted">ComfyUI prompt_id: {s.prompt_id}</div>}
              </details>

              {s.video_path && <video className="video" controls src={fileUrl(projectId, s.video_path)} />}
              {s.error && <p className="m-0 text-danger">错误：{s.error}</p>}
              <div className="row" style={{ marginTop: 8 }}>
                <Input size="sm" className="flex-1" placeholder="反馈（如：镜头拉近 / 让人物微笑），留空直接渲染；有内容会先问是否 LLM 改写" value={feedback[s.id] || ''} onChange={(e) => setFeedback({ ...feedback, [s.id]: e.target.value })} />
                {(() => {
                  const job = activeJobFor(s.id);
                  return (
                    <Button size="sm" isDisabled={!!job} onPress={() => onRegen(s.id)}>
                      {job ? (job.status === 'queued' ? '⏳ 排队中' : '生成中…') : '↻ 重新生成'}
                    </Button>
                  );
                })()}
              </div>
            </CardBody>
          </Card>
        );
      })}
      {!shots.length && <p className="muted">暂无分镜-请先生成素材</p>}

      <Modal isOpen={!!preview} size="3xl" backdrop="blur" onClose={() => setPreview(null)}>
        <ModalContent>
          {() => (
            <ModalBody className="items-center py-6">
              {preview && <img src={fileUrl(projectId, preview.image_path)} className="max-w-full max-h-[78vh] rounded-md" />}
              <div className="mt-2"><b>{preview && preview.name}</b> <span className="muted">{preview && preview.category}</span></div>
            </ModalBody>
          )}
        </ModalContent>
      </Modal>

      <Modal isOpen={!!ask} size="sm" backdrop="blur" onClose={() => setAsk(null)}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader>检测到反馈，需要 LLM 改写提示词</ModalHeader>
              <ModalBody>
                <p className="muted whitespace-pre-line">反馈：{ask ? feedback[ask] || '' : ''}</p>
                <p>LLM 改写完成后，是否继续调用 ComfyUI 渲染视频？</p>
              </ModalBody>
              <ModalFooter>
                <Button size="sm" color="primary" onPress={() => { const id = ask; setAsk(null); regen(id, true); }}>是 · LLM 后渲染视频</Button>
                <Button size="sm" variant="flat" onPress={() => { const id = ask; setAsk(null); regen(id, false); }}>否 · 只做 LLM，不渲染</Button>
                <Button size="sm" variant="light" onPress={() => setAsk(null)}>取消</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {materialPicker && (
        <ShotMaterialPicker
          projectId={projectId}
          assets={assets}
          category={materialPicker.category}
          mode={materialPicker.mode}
          replaceAssetId={materialPicker.replaceAssetId}
          assignedIds={asArr((shots.find((s) => s.id === materialPicker.shotId) || {})[MATERIAL_FIELD[materialPicker.category]])}
          onPick={applyMaterial}
          onCancel={() => setMaterialPicker(null)}
        />
      )}
      <LoadingOverlay show={!!busy} text={busy} />
    </div>
  );
}
