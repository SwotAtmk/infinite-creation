'use client';
import { useEffect, useState, useCallback } from 'react';
import { Card, CardBody, Button } from '@heroui/react';
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
    <Card>
      <CardBody className="gap-2">
        <div className="row justify-between">
          <h2 className="m-0">成片（{files.length}）</h2>
          <Button size="sm" variant="flat" onPress={load}>刷新</Button>
        </div>
        <p className="muted" style={{ marginTop: 6 }}>
          在「生成内容」页点「导出本章成片」后，合并好的最终视频会出现在这里，可在线预览或下载。
        </p>
        {!files.length && <p className="muted">暂无成片，请先在「生成内容」页完成某章并点击「导出本章成片」。</p>}
        {files.map((f) => (
          <Card key={f.rel} shadow="none" className="border border-default-200 mt-3 bg-default-50">
            <CardBody className="gap-2">
              <div className="row justify-between">
                <b style={{ wordBreak: 'break-all' }}>{f.name}</b>
                <div className="row" style={{ gap: 8 }}>
                  <span className="muted">{fmtBytes(f.size)} · {fmtTime(f.mtime)}</span>
                  <Button size="sm" color="primary" onPress={() => download(f)}>⬇ 下载</Button>
                </div>
              </div>
              <video className="video" controls preload="metadata" src={f.url} style={{ maxHeight: 420, marginTop: 8 }} />
            </CardBody>
          </Card>
        ))}
      </CardBody>
    </Card>
  );
}