import { useEffect, useRef, useState } from 'react';
import { RefreshCw, ScrollText, Terminal } from 'lucide-react';
import { api } from '../lib/api.js';
import { JOB_LABEL, JOB_STATUS_META, fmtRelative } from '../lib/format.js';
import { Badge, Button, Select, StatusPill } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';

export default function LogsPage({ projectId, events, jobs, onRefresh }) {
  const [fullLog, setFullLog] = useState(null);
  const [pickedId, setPickedId] = useState('');
  const [logTick, setLogTick] = useState(0);
  const logRef = useRef(null);
  const fullLogRef = useRef(null);
  const logSeqRef = useRef(0);

  const autoJob = jobs.find((j) => j.status === 'running' || j.status === 'queued') || jobs.find((j) => j.logPath) || jobs[0] || null;
  const logJob = (pickedId && jobs.find((j) => j.id === pickedId)) || autoJob;
  const logJobId = logJob ? logJob.id : '';
  const logLive = !!(logJob && (logJob.status === 'running' || logJob.status === 'queued'));

  const lines = jobs.map((j) => '[' + j.status + '] ' + j.type + ' ' + (j.phase || '') + ' ' + (j.detail || '') + (j.error ? ' ERR:' + j.error : ''));
  const ev = events.map((m) => '▶ ' + (m.phase || '') + ' ' + (m.detail || '') + (m.status ? ' [' + m.status + ']' : ''));
  const liveText = [...lines, ...ev].join('\n');

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [liveText]);

  useEffect(() => {
    if (!logJobId) {
      setFullLog(null);
      return undefined;
    }
    const seq = ++logSeqRef.current;
    const load = () =>
      api
        .get('/api/projects/' + projectId + '/jobs/' + logJobId + '/log')
        .then((r) => {
          if (seq === logSeqRef.current) setFullLog(r);
        })
        .catch(() => {
          if (seq === logSeqRef.current) setFullLog(null);
        });
    load();
    if (!logLive) return undefined;
    const t = setInterval(load, 5000);
    return () => {
      clearInterval(t);
      logSeqRef.current += 1;
    };
  }, [projectId, logJobId, logLive, logTick]);

  useEffect(() => {
    if (fullLogRef.current) fullLogRef.current.scrollTop = fullLogRef.current.scrollHeight;
  }, [fullLog]);

  const meta = logJob ? JOB_STATUS_META[logJob.status] : null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Telemetry"
        title="运行日志"
        description="实时进度来自 WebSocket；完整日志包含 Agent 每一步工具调用、技能加载与模型输出。"
        actions={
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              setLogTick((t) => t + 1);
              onRefresh && onRefresh();
            }}
          >
            <RefreshCw size={13} /> 刷新
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className="panel flex min-w-0 flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Terminal size={14} className="text-[var(--fg-3)]" />
              <span className="text-[12.5px] font-medium text-[var(--fg-2)]">实时进度</span>
            </div>
            <div className="flex items-center gap-2">
              {jobs.some((j) => j.status === 'running' || j.status === 'queued') ? <Badge tone="accent" dot>运行中</Badge> : <Badge tone="neutral">空闲</Badge>}
              <span className="text-[10.5px] text-[var(--fg-4)]">{events.length} 条事件</span>
            </div>
          </div>
          <pre ref={logRef} className="logbox max-h-[430px] min-h-[240px]">
            {liveText || '（暂无日志，在「章节管理」里点击生成启动流水线）'}
          </pre>
          <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
            生成过程全自动，一整章视频会逐镜串行生成，可长时间运行；结束后回到「分镜审查」复核每个镜头。
          </p>
        </section>

        <section className="panel flex min-w-0 flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ScrollText size={14} className="text-[var(--fg-3)]" />
              <span className="text-[12.5px] font-medium text-[var(--fg-2)]">完整日志</span>
              {meta ? <StatusPill status={logJob.status}>{meta.label}</StatusPill> : null}
            </div>
            <div className="w-[220px] max-w-full">
              <Select
                value={pickedId}
                onChange={setPickedId}
                size="sm"
                items={[
                  { value: '', label: '自动：当前 / 最近任务' },
                  ...jobs.map((j) => ({
                    value: j.id,
                    label: (JOB_LABEL[j.type] || j.type) + (j.subjectLabel ? ' · ' + j.subjectLabel : '') + ' · ' + (JOB_STATUS_META[j.status]?.label || j.status),
                  })),
                ]}
              />
            </div>
          </div>

          {logJob ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-[var(--fg-4)]">
              <span>{JOB_LABEL[logJob.type] || logJob.type}</span>
              {logJob.subjectLabel ? <span>· {logJob.subjectLabel}</span> : null}
              <span>· {fmtRelative(logJob.startedAt)}</span>
              {logJob.phase ? <span>· {logJob.phase}</span> : null}
            </div>
          ) : null}

          <pre ref={fullLogRef} className="logbox max-h-[520px] min-h-[300px]">
            {fullLog ? fullLog.text || '（空）' : '（暂无完整日志）'}
          </pre>
          {fullLog && fullLog.logPath ? <p className="m-0 break-all font-mono text-[10px] text-[var(--fg-4)]">日志文件：{fullLog.logPath}</p> : null}
        </section>
      </div>
    </div>
  );
}
