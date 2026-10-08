'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api-client.js';
import { useToast } from '../toast';

// ============ 成片（导出视频） ============
export default function ExportsTab({ projectId }) {
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const load = useCallback(() => api.get('/api/projects/' + projectId + '/exports').then((r) => setFiles(r.files || [])).catch((e) => toast.error(e.message)), [projectId]);
  useEffect(() => { load(); }, [load]);

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function fmtTime(ms) { try { return new Date(ms).toLocaleString('zh-CN'); } catch { return ''; } }
  function download(f) {
    const a = document.createElement('a');
    a.href = '/api/projects/' + projectId + '/exports/' + encodeURIComponent(f.name) + '/download';
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>成片（{files.length}）</h2>
        <button onClick={load}>刷新</button>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        在「生成内容」页点「导出本章成片」后，合并好的最终视频会出现在这里，可在线预览或下载。
      </p>
      {!files.length && <p className="muted">暂无成片，请先在「生成内容」页完成某章并点击「导出本章成片」。</p>}
      {files.map((f) => (
        <div key={f.rel} className="card" style={{ marginTop: 12, background: '#10131a' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b style={{ wordBreak: 'break-all' }}>{f.name}</b>
            <div className="row" style={{ gap: 8 }}>
              <span className="muted">{fmtBytes(f.size)} · {fmtTime(f.mtime)}</span>
              <button className="primary" onClick={() => download(f)}>⬇ 下载</button>
            </div>
          </div>
          <video className="video" controls preload="metadata" src={f.url} style={{ maxHeight: 420, marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}