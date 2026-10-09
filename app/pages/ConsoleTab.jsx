'use client';
import { useEffect, useState, useRef } from 'react';
import { Card, CardBody, Button } from '@heroui/react';
import { api } from '../api-client.js';

// ============ 控制台 ============
export default function ConsoleTab({ projectId, events, jobs, onRefresh }) {
  const [log, setLog] = useState('');
  const [fullLog, setFullLog] = useState(null);
  const logRef = useRef(null);
  const fullLogRef = useRef(null);
  useEffect(() => {
    const lines = jobs.map((j) => '[' + j.status + '] ' + j.type + ' ' + (j.phase || '') + ' ' + (j.detail || '') + (j.error ? ' ERR:' + j.error : ''));
    const ev = events.map((m) => '▶ ' + (m.phase || '') + ' ' + (m.detail || '') + (m.status ? ' [' + m.status + ']' : ''));
    setLog([...lines, ...ev].join('\n'));
  }, [events, jobs]);
  // 主进度日志：内容变化时滚到底部
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);
  useEffect(() => {
    const job = jobs[0];
    if (!job) { setFullLog(null); return; }
    api.get('/api/projects/' + projectId + '/jobs/' + job.id + '/log')
      .then(setFullLog)
      .catch(() => setFullLog(null));
  }, [projectId, jobs]);
  // 完整日志：加载/变化时滚到底部
  useEffect(() => {
    if (fullLogRef.current) fullLogRef.current.scrollTop = fullLogRef.current.scrollHeight;
  }, [fullLog]);
  return (
    <Card>
      <CardBody className="gap-2">
        <div className="row justify-between">
          <h2 className="m-0">运行日志</h2>
          <Button size="sm" variant="flat" onPress={onRefresh}>刷新</Button>
        </div>
        <pre className="logbox" ref={logRef}>{log || '（暂无日志，在「生成内容」页点击生成启动流水线）'}</pre>
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>完整日志（Agent 每一步工具调用 / 技能加载 / 模型输出）</div>
          <pre className="logbox" ref={fullLogRef} style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>{fullLog ? (fullLog.text || '（空）') : '（暂无完整日志）'}</pre>
          {fullLog && <p className="muted" style={{ wordBreak: 'break-all' }}>日志文件：{fullLog.logPath || ''}</p>}
        </div>
        <p className="muted">生成过程全自动、无需人工介入；一整章视频会逐镜串行生成，可长时间运行。结束后回到「生成内容」页复核每个镜头。</p>
      </CardBody>
    </Card>
  );
}