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
  // 完整日志默认看「最相关的那条」：正在执行/排队的任务 → 最新一条写过日志文件的任务 → 最新任务。
  // 原先固定取 jobs[0]（最后创建的一条），而最后创建的常常是刚入队、还没写日志的命名/子任务，
  // 面板显示成「（暂无完整日志）」——用户想排查刚失败的那条，看到的却是别人的日志。
  const logJob = jobs.find((j) => j.status === 'running' || j.status === 'queued')
    || jobs.find((j) => j.logPath)
    || jobs[0] || null;
  const logJobId = logJob ? logJob.id : '';
  const logLive = !!(logJob && (logJob.status === 'running' || logJob.status === 'queued'));
  const [logTick, setLogTick] = useState(0);      // 「刷新」按钮：让完整日志立刻重取
  const logSeqRef = useRef(0);
  useEffect(() => {
    if (!logJobId) { setFullLog(null); return undefined; }
    // 依赖是「目标任务 id」而不是 jobs 数组：加载中每 2.5s 刷新一次项目、每条 WS 消息也会刷，
    // jobs 每次都换一个新的数组引用 —— 原先会让完整日志（后端 fs.readFileSync 整个日志文件）
    // 跟着被反复重取，任务越久、日志越大越重。
    // seq 用来丢弃过期响应：换任务/换项目时旧请求可能后到，不能覆盖新任务的内容。
    const seq = ++logSeqRef.current;
    const load = () => api.get('/api/projects/' + projectId + '/jobs/' + logJobId + '/log')
      .then((r) => { if (seq === logSeqRef.current) setFullLog(r); })
      .catch(() => { if (seq === logSeqRef.current) setFullLog(null); });
    load();
    if (!logLive) return undefined;   // 任务已结束：日志不会再变，不必轮询
    const t = setInterval(load, 5000);
    return () => { clearInterval(t); logSeqRef.current += 1; };
  }, [projectId, logJobId, logLive, logTick]);
  // 完整日志：加载/变化时滚到底部
  useEffect(() => {
    if (fullLogRef.current) fullLogRef.current.scrollTop = fullLogRef.current.scrollHeight;
  }, [fullLog]);
  return (
    <Card>
      <CardBody className="gap-2">
        <div className="row justify-between">
          <h2 className="m-0">运行日志</h2>
          <Button size="sm" variant="flat" onPress={() => { setLogTick((t) => t + 1); onRefresh(); }}>刷新</Button>
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