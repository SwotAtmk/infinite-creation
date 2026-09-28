'use client';
import { useEffect, useState } from 'react';
import { api } from '../api-client.js';

// ============ 控制台 ============
export default function ConsoleTab({ projectId, events, jobs, onRefresh }) {
  const [log, setLog] = useState('');
  const [fullLog, setFullLog] = useState(null);
  useEffect(() => {
    const lines = jobs.map((j) => '[' + j.status + '] ' + j.type + ' ' + (j.phase || '') + ' ' + (j.detail || '') + (j.error ? ' ERR:' + j.error : ''));
    const ev = events.map((m) => '▶ ' + (m.phase || '') + ' ' + (m.detail || '') + (m.status ? ' [' + m.status + ']' : ''));
    setLog([...lines, ...ev].join('\n'));
  }, [events, jobs]);
  useEffect(() => {
    const job = jobs[0];
    if (!job) { setFullLog(null); return; }
    api.get('/api/projects/' + projectId + '/jobs/' + job.id + '/log')
      .then(setFullLog)
      .catch(() => setFullLog(null));
  }, [projectId, jobs]);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>运行日志</h2>
        <button onClick={onRefresh}>刷新</button>
      </div>
      <pre className="logbox">{log || '（暂无日志，在「生成内容」页点击生成启动流水线）'}</pre>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>完整日志（Agent 每一步工具调用 / 技能加载 / 模型输出）</div>
        <pre className="logbox" style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>{fullLog ? (fullLog.text || '（空）') : '（暂无完整日志）'}</pre>
        {fullLog && <p className="muted" style={{ wordBreak: 'break-all' }}>日志文件：{fullLog.logPath || ''}</p>}
      </div>
      <p className="muted">生成过程全自动、无需人工介入；一整章视频会逐镜串行生成，可长时间运行。结束后回到「生成内容」页复核每个镜头。</p>
    </div>
  );
}