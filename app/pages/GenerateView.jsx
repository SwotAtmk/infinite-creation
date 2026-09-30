'use client';
import { useState } from 'react';
import { api } from '../api-client.js';
import ShotsTab from './ShotsTab';

// ============ 页2 · 生成内容 ============
export default function GenerateView({ projectId, chapters, cursor, setCursor, running, onRun, onStop, onRefresh, onGoLogs }) {
  const cur = chapters[cursor] || chapters[0] || null;
  const [runTip, setRunTip] = useState(false);
  const [starting, setStarting] = useState(false);
  async function startRun(title) {
    if (!title) return;
    setRunTip(true);
    setStarting(true);
    try { await onRun(title); } finally { setStarting(false); }
  }
  async function regenChapter(mode) {
    if (!cur) return;
    const msg = mode === 'storyboard'
      ? '将清空「' + cur.title + '」当前的分镜，重新拆分并生成全部视频（素材保留）。确定继续？'
      : '将清空「' + cur.title + '」已生成的视频，按现有分镜重新生成全部视频（分镜与素材保留）。确定继续？';
    if (!window.confirm(msg)) return;
    try { await api.post('/api/projects/' + projectId + '/chapters/' + cur.id + '/regenerate' + (mode === 'storyboard' ? '?mode=full' : '')); onRun(cur.title); } catch (e) { alert(e.message); }
  }
  return (
    <div>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>生成内容</h2>
          <select value={cursor} onChange={(e) => setCursor(Number(e.target.value))}>
            {chapters.map((c, i) => <option key={c.id} value={i}>{c.title}</option>)}
          </select>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {running
            ? <button className="danger" onClick={onStop}>■ 停止</button>
            : <button className="primary" disabled={!cur} onClick={() => cur && startRun(cur.title)}>▶ 生成/继续 {cur ? cur.title : ''}</button>}
          {!running && <button onClick={() => onRun(null)}>生成全部章节</button>}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {!running && <button onClick={() => regenChapter('storyboard')} disabled={!cur}>↻ 重新生成分镜</button>}
          {!running && <button onClick={() => regenChapter('videos')} disabled={!cur}>↻ 重新生成视频</button>}
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          点「生成/继续」就接着上次进度跑（已完成的素材/分镜/视频自动跳过），中断或失败后点它即可继续。
          「重新生成分镜」清空本章分镜、重新拆分并出视频（素材保留）。
          「重新生成视频」保留分镜，只重做本章全部视频。
        </p>
      </div>
      {cur && <ShotsTab projectId={projectId} chapter={cur.title} running={running} onRefresh={onRefresh} />}

      {runTip && (
        <div className="modal-bg" onClick={() => setRunTip(false)}>
          <div className="modal" style={{ width: 'min(460px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ gap: 10 }}>
              {starting && <span className="spinner" />}
              <h2 style={{ margin: 0 }}>正在生成</h2>
            </div>
            <p style={{ marginTop: 10, color: '#9aa4b2' }}>正在生成，可以前往「运行日志」查看运行状态……</p>
            <div className="row" style={{ marginTop: 16 }}>
              <button className="primary" onClick={() => { setRunTip(false); onGoLogs && onGoLogs(); }}>前往运行日志</button>
              <button onClick={() => setRunTip(false)}>留在本页</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}