'use client';
// 成片轻量剪辑（方案 A）：时间轴圈选 -> 保留选区 / 删除选区。
// 剪辑在后端生成新 mp4，原片与已有备份都不动；缩略图在浏览器端抽帧，失败则退回渐变时间轴。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Checkbox, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast.jsx';

const fmt = (t) => {
  const v = Math.max(0, Number(t) || 0);
  const m = Math.floor(v / 60), s = v - m * 60;
  return String(m).padStart(2, '0') + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
};
const fmt3 = (t) => {
  const v = Math.max(0, Number(t) || 0);
  const m = Math.floor(v / 60), s = v - m * 60;
  return String(m).padStart(2, '0') + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
};
const snapTo = (t, fps) => +(Math.round((Number(t) || 0) * fps) / fps).toFixed(4);

export default function ClipEditor({ projectId, file, onClose, onDone }) {
  const toast = useToast();
  const videoRef = useRef(null);
  const timelineRef = useRef(null);
  const durationRef = useRef(0);
  const [duration, setDuration] = useState(0);
  const [fps, setFps] = useState(24);
  const [sel, setSel] = useState(null);
  const [playhead, setPlayhead] = useState(0);
  const [strip, setStrip] = useState('');
  const [backup, setBackup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [scenes, setScenes] = useState([]);
  const [sceneThumbs, setSceneThumbs] = useState([]);
  const [framePreview, setFramePreview] = useState('');
  const grabRef = useRef(null);
  const queueRef = useRef([]);
  const grabbingRef = useRef(false);
  const pumpRef = useRef(() => {});

  const trimUrl = '/api/projects/' + projectId + '/exports/' + encodeURIComponent(file.name) + '/trim';
  const scenesUrl = trimUrl.replace(/\/trim$/, '/scenes');
  const acceptDuration = useCallback((d, rate = 24) => {
    if (!Number.isFinite(d) || d <= 0 || durationRef.current > 0) return;
    durationRef.current = d;
    setDuration(d);
    setSel({ start: snapTo(d * 0.25, rate), end: snapTo(d * 0.75, rate) });
  }, []);

  useEffect(() => {
    api.get(trimUrl).then((r) => {
      const rate = Number(r?.fps) > 0 ? Number(r.fps) : 24;
      setFps(rate);
      acceptDuration(Number(r?.duration), rate);
    }).catch(() => {});
  }, [trimUrl, acceptDuration]);

  // 单帧抓图：用一个隐藏 video 串行 seek，避免并发 seek 互相打断。
  pumpRef.current = () => {
    const v = grabRef.current;
    if (!v || grabbingRef.current || !queueRef.current.length) return;
    if (!Number.isFinite(v.duration) || v.duration <= 0) return;
    const job = queueRef.current.shift();
    grabbingRef.current = true;
    const drawFrame = () => {
      const cv = document.createElement('canvas');
      cv.width = 240; cv.height = 135;
      cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/jpeg', 0.75);
    };
    const finish = (url) => { grabbingRef.current = false; job.resolve(url); pumpRef.current(); };
    const target = Math.max(0, Math.min(v.duration - 0.02, Number(job.t) || 0));
    const onSeek = () => { v.removeEventListener('seeked', onSeek); let url = ''; try { url = drawFrame(); } catch {} finish(url); };
    if (Math.abs(v.currentTime - target) < 0.001) {
      let url = ''; try { url = drawFrame(); } catch {}
      finish(url);
      return;
    }
    v.addEventListener('seeked', onSeek);
    v.currentTime = target;
  };
  const captureFrame = useCallback((t) => new Promise((resolve) => {
    queueRef.current.push({ t, resolve });
    pumpRef.current();
  }), []);

  useEffect(() => {
    api.get(scenesUrl).then((r) => setScenes(Array.isArray(r?.scenes) ? r.scenes : [])).catch(() => setScenes([]));
  }, [scenesUrl]);

  useEffect(() => {
    if (!scenes.length) { setSceneThumbs([]); return; }
    let cancelled = false;
    Promise.all(scenes.slice(0, 16).map((s) => captureFrame(s.time)))
      .then((urls) => { if (!cancelled) setSceneThumbs(urls); });
    return () => { cancelled = true; };
  }, [scenes, captureFrame]);

  // 浏览器端抽 10 帧拼一条缩略图；同源 /files 支持 Range，seek 很快。失败/超时就留空用渐变底。
  useEffect(() => {
    let cancelled = false;
    const v = document.createElement('video');
    v.preload = 'auto'; v.muted = true; v.playsInline = true; v.src = file.url;
    const N = 10, W = 128, H = 72;
    const cv = document.createElement('canvas');
    cv.width = W * N; cv.height = H;
    const ctx = cv.getContext('2d');
    let i = 0;
    const next = () => {
      if (cancelled || i >= N) return;
      if (!Number.isFinite(v.duration) || v.duration <= 0) return;
      v.currentTime = Math.min(Math.max(0, v.duration - 0.05), (i + 0.5) * v.duration / N);
    };
    const draw = () => {
      if (cancelled) return;
      try { ctx.drawImage(v, i * W, 0, W, H); } catch {}
      i++;
      next();
    };
    const fail = () => { if (!cancelled) setStrip(''); };
    const timer = setTimeout(() => { if (!cancelled && i < N) fail(); }, 10000);
    v.addEventListener('seeked', draw);
    v.addEventListener('error', fail);
    v.addEventListener('loadedmetadata', next);
    return () => {
      cancelled = true; clearTimeout(timer);
      v.removeEventListener('seeked', draw);
      v.removeEventListener('error', fail);
      v.removeEventListener('loadedmetadata', next);
      v.removeAttribute('src'); v.load();
    };
  }, [file.url]);

  const pct = (t) => (duration > 0 ? Math.max(0, Math.min(100, t / duration * 100)) : 0) + '%';
  const range = sel || { start: 0, end: duration };
  const timeAt = (clientX) => {
    const el = timelineRef.current;
    if (!el || duration <= 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - r.left) / r.width * duration));
  };
  const frameDur = 1 / fps;
  const snap = (t) => snapTo(t, fps);
  const frameNo = (t) => Math.round((Number(t) || 0) * fps);

  const previewAt = (t) => captureFrame(t).then(setFramePreview);

  function nudge(which, frames) {
    const step = frames / fps;
    if (which === 'playhead') {
      const t = Math.max(0, Math.min(duration, playhead + step));
      if (videoRef.current) videoRef.current.currentTime = t;
      setPlayhead(t);
      previewAt(t);
      return;
    }
    if (!sel) return;
    if (which === 'start') {
      const s = Math.max(0, Math.min(snap(sel.start + step), sel.end - frameDur));
      setSel({ ...sel, start: s });
      previewAt(s);
    } else {
      const e = Math.min(duration, Math.max(snap(sel.end + step), sel.start + frameDur));
      setSel({ ...sel, end: e });
      previewAt(e);
    }
  }

  function gotoScene(s) {
    const t = Math.min(duration, s.time);
    if (videoRef.current) videoRef.current.currentTime = t;
    setPlayhead(t);
    previewAt(t);
    const a = snap(Math.max(0, t - 0.5));
    const b = Math.min(duration, snap(t + 0.5));
    if (b <= a + frameDur) return;
    setSel({ start: a, end: b });
  }

  useEffect(() => {
    const onKey = (e) => {
      if (busy) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(e.shiftKey ? 'end' : 'start', -1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(e.shiftKey ? 'end' : 'start', 1); }
      else if (e.key === ',') { e.preventDefault(); nudge('playhead', -1); }
      else if (e.key === '.') { e.preventDefault(); nudge('playhead', 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fps, sel, playhead, duration, busy]);

  function onTimelineDown(e) {
    const handle = e.target.dataset?.handle;
    const t = timeAt(e.clientX);
    if (handle && sel) {
      e.preventDefault();
      const startX = t;
      const initial = { ...sel };
      const len = initial.end - initial.start;
      const move = (ev) => {
        const x = timeAt(ev.clientX);
        if (handle === 'l') {
          setSel({ ...initial, start: snap(Math.min(x, initial.end - frameDur)) });
        } else if (handle === 'r') {
          setSel({ ...initial, end: snap(Math.max(x, initial.start + frameDur)) });
        } else {
          const s = snap(Math.max(0, Math.min(initial.start + x - startX, duration - len)));
          setSel({ start: s, end: Math.min(duration, snap(s + len)) });
        }
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    if (videoRef.current) { videoRef.current.currentTime = t; setPlayhead(t); }
  }

  function preset(kind) {
    if (!duration) return;
    const three = Math.min(3, duration / 3);
    setSel(kind === 'head'
      ? { start: 0, end: Math.min(duration, snap(three)) }
      : { start: snap(duration - three), end: Math.min(duration, snap(duration)) });
  }

  async function submit(mode) {
    if (!sel || duration <= 0 || busy) return;
    if (sel.end - sel.start < frameDur * 0.9) { toast.error('选区至少 1 帧（' + frameDur.toFixed(3) + ' 秒）'); return; }
    setBusy(true);
    try {
      const r = await api.post(trimUrl, { mode, startSec: sel.start, endSec: sel.end, backup });
      toast.success('剪辑完成：' + r.name + (r.backup ? '（原片已备份）' : ''));
      onDone?.();
      onClose?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen size="4xl" backdrop="blur" onClose={() => { if (!busy) onClose?.(); }}>
      <ModalContent>
        <ModalHeader className="pb-1">
          <div className="min-w-0">
            <div>剪辑成片</div>
            <div className="muted truncate" style={{ maxWidth: 640 }} title={file.name}>{file.name}</div>
          </div>
        </ModalHeader>
        <ModalBody>
          <video
            ref={grabRef}
            src={file.url}
            preload="auto"
            muted
            playsInline
            className="hidden"
            onLoadedMetadata={() => pumpRef.current()}
          />
          <div
            className="relative h-16 rounded-lg overflow-hidden border border-default-200 bg-black select-none touch-none"
            ref={timelineRef}
            onPointerDown={onTimelineDown}
          >
            {strip
              ? <img src={strip} alt="时间轴缩略图" draggable={false} className="w-full h-full pointer-events-none opacity-80" style={{ objectFit: 'fill' }} />
              : <div className="w-full h-full pointer-events-none" style={{ background: 'repeating-linear-gradient(90deg,#1b2433,#1b2433 9%,#233149 9%,#233149 10%)' }} />}
            <div className="absolute top-0 bottom-0 bg-black/70 pointer-events-none" style={{ left: 0, width: pct(range.start) }} />
            <div className="absolute top-0 bottom-0 bg-black/70 pointer-events-none" style={{ left: pct(range.end), right: 0 }} />
            <div className="absolute top-0 bottom-0 border-2 border-primary bg-primary/10 pointer-events-none" style={{ left: pct(range.start), width: pct(range.end - range.start) }}>
              <span data-handle="l" className="absolute left-0 top-0 bottom-0 w-3 bg-primary cursor-ew-resize pointer-events-auto flex items-center justify-center text-white" style={{ fontSize: 10 }}>⋮</span>
              <span data-handle="move" title="拖动整个选区（时长不变）" className="absolute left-1/2 top-0 bottom-0 w-6 -translate-x-1/2 bg-primary/90 hover:bg-primary cursor-grab active:cursor-grabbing pointer-events-auto flex items-center justify-center text-white shadow" style={{ fontSize: 11 }}>⠿</span>
              <span data-handle="r" className="absolute right-0 top-0 bottom-0 w-3 bg-primary cursor-ew-resize pointer-events-auto flex items-center justify-center text-white" style={{ fontSize: 10 }}>⋮</span>
            </div>
            <div className="absolute top-0 bottom-0 w-0.5 bg-white pointer-events-none" style={{ left: pct(playhead), boxShadow: '0 0 6px #fff' }} />
            {scenes.map((s, i) => (
              <div key={i} className="absolute top-0 bottom-0 w-px bg-warning pointer-events-none" style={{ left: pct(s.time) }} title={'镜头切换 ' + fmt3(s.time)} />
            ))}
          </div>
          <div className="row justify-between muted" style={{ fontSize: 11 }}>
            <span>0:00</span><span>{fmt(duration / 2)}</span><span>{fmt(duration)}</span>
          </div>
          <p className="muted" style={{ marginTop: 2 }}>拖选区中间的 ⠿ 整体平移（时长不变），两端 ⋮ 改边界；所有边界自动吸附到帧网格，选区内部可直接点击跳转。</p>

          <video
            ref={videoRef}
            className="video w-full bg-black rounded-lg"
            style={{ maxHeight: 340 }}
            controls
            preload="metadata"
            src={file.url}
            onLoadedMetadata={(e) => { acceptDuration(e.currentTarget.duration); setPlayhead(e.currentTarget.currentTime); }}
            onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
          />

          <div className="row justify-between" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 16 }}>
              <span className="muted">选区 <b className="text-foreground">{fmt3(range.start)} → {fmt3(range.end)}</b></span>
              <span className="muted">时长 <b className="text-foreground">{(range.end - range.start).toFixed(3)} 秒 / {Math.max(0, frameNo(range.end) - frameNo(range.start))} 帧</b></span>
              <span className="muted">帧率 <b className="text-foreground">{fps} fps</b></span>
            </div>
            <Button size="sm" variant="light" onPress={() => setSel({ start: snap(duration * 0.25), end: Math.min(duration, snap(duration * 0.75)) })}>重置选区</Button>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <span className="muted">逐帧微调</span>
            <span className="muted">起点帧 <b className="text-foreground">{frameNo(range.start)}</b></span>
            <Button size="sm" variant="flat" isDisabled={!sel} onPress={() => nudge('start', -1)}>−1帧</Button>
            <Button size="sm" variant="flat" isDisabled={!sel} onPress={() => nudge('start', 1)}>+1帧</Button>
            <span className="muted">终点帧 <b className="text-foreground">{frameNo(range.end)}</b></span>
            <Button size="sm" variant="flat" isDisabled={!sel} onPress={() => nudge('end', -1)}>−1帧</Button>
            <Button size="sm" variant="flat" isDisabled={!sel} onPress={() => nudge('end', 1)}>+1帧</Button>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <span className="muted">播放头帧 <b className="text-foreground">{frameNo(playhead)}</b> · {fmt3(playhead)}</span>
            <Button size="sm" variant="flat" onPress={() => nudge('playhead', -1)}>−1帧</Button>
            <Button size="sm" variant="flat" onPress={() => nudge('playhead', 1)}>+1帧</Button>
            <span className="muted">快捷键：←/→ 调起点，Shift+←/→ 调终点，逗号/句号移动播放头</span>
          </div>

          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div style={{ width: 240, flexShrink: 0 }}>
              <div className="muted">当前帧画面</div>
              {framePreview
                ? <img src={framePreview} alt="当前帧" className="w-full rounded-lg border border-default-200" />
                : <div className="w-full rounded-lg border border-default-200 bg-default-100 flex items-center justify-center muted" style={{ aspectRatio: '16 / 9' }}>点逐帧按钮显示画面</div>}
              <div className="muted">{fmt3(playhead)} · 帧 {frameNo(playhead)}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row justify-between">
                <span className="muted">镜头切换点（{scenes.length}）· 时间轴上的黄色竖线</span>
                {scenes.length > 16 && <span className="muted">先显示前 16 个</span>}
              </div>
              <div className="flex gap-2 overflow-x-auto py-2">
                {!scenes.length && <span className="muted">未检测到明显切镜，可用上方逐帧按钮手动找点。</span>}
                {scenes.slice(0, 16).map((s, i) => (
                  <Button key={i} size="sm" variant="flat" className="flex-col h-auto py-1 px-1" style={{ minWidth: 116 }} onPress={() => gotoScene(s)}>
                    {sceneThumbs[i]
                      ? <img src={sceneThumbs[i]} alt="" className="rounded" style={{ width: 104, height: 58, objectFit: 'cover' }} />
                      : <div className="rounded bg-default-100" style={{ width: 104, height: 58 }} />}
                    <span className="muted" style={{ fontSize: 11 }}>{fmt3(s.time)} · 帧{s.frame}</span>
                  </Button>
                ))}
              </div>
              <p className="muted">点切换点缩略图：自动框选该点前后 0.5 秒，再点「删除选区」即可剪掉这段。</p>
            </div>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <span className="muted">快捷圈选</span>
            <Button size="sm" variant="flat" onPress={() => preset('head')}>剪掉片头 3 秒</Button>
            <Button size="sm" variant="flat" onPress={() => preset('tail')}>剪掉片尾 3 秒</Button>
            <span className="muted">只设选区，再点下方按钮执行</span>
          </div>

          <Checkbox size="sm" isSelected={backup} onValueChange={setBackup}>剪辑前自动备份原片（存到 backups/，不覆盖任何已有文件）</Checkbox>
          {busy && <div className="row" style={{ gap: 8 }}><Spinner size="sm" /><span className="muted">正在剪辑，生成的成片会出现在成片列表…</span></div>}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" isDisabled={busy} onPress={() => onClose?.()}>取消</Button>
          <Button color="primary" isDisabled={busy || !sel || duration <= 0} onPress={() => submit('keep')}>保留选区</Button>
          <Button color="danger" isDisabled={busy || !sel || duration <= 0} onPress={() => submit('cut')}>删除选区</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
