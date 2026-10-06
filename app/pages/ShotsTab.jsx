'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api-client.js';
import { STATUS_TAG, fileUrl, dialogueSpeakers } from './shared';
import { useToast } from '../toast';

// ============ 分镜审查 ============
export default function ShotsTab({ projectId, chapter: chapterProp = '', running = false, onRefresh }) {
  const toast = useToast();
  const [shots, setShots] = useState([]);
  const [assets, setAssets] = useState([]);
  const [project, setProject] = useState(null);
  const [preview, setPreview] = useState(null);
  const [feedback, setFeedback] = useState({});
  const [zipping, setZipping] = useState(false);
  const load = useCallback(() => {
    api.get('/api/projects/' + projectId + '/shots').then(setShots).catch((e) => toast.error(e.message));
    api.get('/api/projects/' + projectId + '/assets').then(setAssets).catch((e) => toast.error(e.message));
    api.get('/api/projects/' + projectId).then(setProject).catch(() => {});
  }, [projectId]);
  // 生成期间定时拉取，实时反映每个分镜的生成结果（Agent 逐镜写库，没有逐镜的 WS 事件）
  useEffect(() => {
    load();
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);
  const shown = chapterProp ? shots.filter((s) => (s.chapter || '默认') === chapterProp) : shots;
  const doneShots = shown.filter((s) => s.video_path && s.status === 'done');

  const byId = (id) => assets.find((a) => a.id === id);
  const asArr = (v) => Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } })() : []);
  const charsOf = (s) => asArr(s.character_ids).map(byId).filter(Boolean);
  const scenesOf = (s) => asArr(s.scene_ids).map(byId).filter(Boolean);
  const propsOf = (s) => asArr(s.prop_ids).map(byId).filter(Boolean);
  const costumesOf = (s) => asArr(s.costume_ids).map(byId).filter(Boolean);

  function RefThumb({ a }) {
    return (
      <div style={{ textAlign: 'center', width: 76 }}>
        {a.image_path
          ? <img className="thumb" src={fileUrl(projectId, a.image_path)} onClick={() => setPreview(a)} style={{ width: 64, height: 64, objectFit: 'cover', cursor: 'zoom-in' }} title="点击预览" />
          : <div className="thumb" style={{ width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}>{a.category}</div>}
        <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{a.name}</div>
      </div>
    );
  }

  async function regen(shotId) {
    const fb = feedback[shotId] || undefined;
    try { await api.post('/api/projects/' + projectId + '/shots/' + shotId + '/regenerate', { feedback: fb }); toast.success('已提交重生成'); load(); } catch (e) { toast.error(e.message); }
  }
  async function exportChapter() {
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
  }
  async function zipShots() {
    setZipping(true);
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
    finally { setZipping(false); }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <h2>分镜审查（{chapterProp ? chapterProp + ' · ' : ''}共 {shown.length} 镜）</h2>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="primary" onClick={exportChapter} disabled={!shown.length}>导出本章成片</button>
          <button onClick={zipShots} disabled={!doneShots.length || zipping}>{zipping ? '打包中…' : '📦 打包下载片段'}</button>
        </div>
      </div>
      {shown.map((s) => {
        const chars = charsOf(s), scenes = scenesOf(s), props = propsOf(s), costumes = costumesOf(s);
        // 语音参考只显示「有台词」角色（与后端 assembleShotReferences 一致）：多人同场时仅说话角色才有音色
        const speakers = dialogueSpeakers(s.dialogue);
        const speakingChars = chars.filter((c) => speakers.some((sp) => sp === c.name || sp.includes(c.name) || c.name.includes(sp)));
        const voices = speakingChars.filter((c) => c.voice_ref).map((c) => ({ name: c.name, voice_ref: c.voice_ref }));
        const allRefs = [...chars, ...scenes, ...props, ...costumes];
        const resoLabel = s.resolution === 'custom' && project
          ? 'custom ' + (project.video_width || '?') + '×' + (project.video_height || '?')
          : (s.resolution || '480P');
        return (
          <div className="card" key={s.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>分镜 {s.idx}{s.chapter ? ' · ' + s.chapter : ''} · {s.scene_name || '未命名'}</b>
              <span className={'tag ' + (STATUS_TAG[s.status] || '')}>{s.status}</span>
            </div>
            <div className="muted">时长 {s.duration}s · 分辨率 {resoLabel} · 比例 {s.aspect_ratio || '16:9'} · seed {s.seed || '-'}</div>

            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ marginBottom: 4 }}>参考素材（角色 / 场景 / 道具 / 服装 / 语音〔仅台词角色〕）</div>
              {allRefs.length || voices.length ? (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  {chars.map((a) => <RefThumb key={a.id} a={a} />)}
                  {scenes.map((a) => <RefThumb key={a.id} a={a} />)}
                  {props.map((a) => <RefThumb key={a.id} a={a} />)}
                  {costumes.map((a) => <RefThumb key={a.id} a={a} />)}
                  {voices.map((v, i) => (
                    <div key={i} style={{ textAlign: 'center', width: 190 }}>
                      <audio controls src={fileUrl(projectId, v.voice_ref)} style={{ width: '100%', height: 38 }} title="角色参考音色" />
                      <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{v.name}</div>
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
            {s.error && <p style={{ color: '#ff8080' }}>错误：{s.error}</p>}
            <div className="row" style={{ marginTop: 8 }}>
              <input placeholder="反馈（如：镜头拉近 / 让人物微笑），留空则换种子重生成" value={feedback[s.id] || ''} onChange={(e) => setFeedback({ ...feedback, [s.id]: e.target.value })} style={{ flex: 1 }} />
              <button onClick={() => regen(s.id)}>↻ 重新生成</button>
            </div>
          </div>
        );
      })}
      {!shots.length && <p className="muted">暂无分镜</p>}
      {preview && (
        <div className="modal-bg" onClick={() => setPreview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '90vw', textAlign: 'center' }}>
            <img src={fileUrl(projectId, preview.image_path)} style={{ maxWidth: '100%', maxHeight: '78vh', borderRadius: 6 }} />
            <div style={{ marginTop: 8 }}><b>{preview.name}</b> <span className="muted">{preview.category}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}