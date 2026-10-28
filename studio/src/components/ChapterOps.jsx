import { useEffect, useState } from 'react';
import { Check, Film, Image as ImageIcon, Layers, Mic2, Play, Square, Wand2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button, Spinner } from './ui.jsx';
import { BusyOverlay } from './overlays.jsx';
import { useToast } from './toast.jsx';

const STAGE_ICON = { llm: Wand2, image: ImageIcon, tts: Mic2, video: Film };

export default function ChapterOps({ projectId, chapter, running, runningChapter, onRun, onStop, onRefresh, onGoLogs }) {
  const toast = useToast();
  const [stageList, setStageList] = useState(null);
  const [pending, setPending] = useState({});
  const [picked, setPicked] = useState(() => new Set());
  const [stageErr, setStageErr] = useState('');
  const [stageLoadErr, setStageLoadErr] = useState('');
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get('/api/projects/' + projectId + '/stages')
        .then((d) => {
          if (!alive) return;
          setStageList(d.stages);
          setPending(d.pending || {});
          setStageLoadErr('');
        })
        .catch((e) => {
          if (alive) setStageLoadErr('分阶段运行加载失败：' + (e && e.message ? e.message : e));
        });
    load();
    if (!running) return () => { alive = false; };
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectId, running]);

  function toggleStage(id) {
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function submittedToast(text) {
    toast.open({
      kind: 'info',
      message: text,
      buttons: [{ label: '前往运行日志', tone: 'primary', onClick: () => onGoLogs && onGoLogs() }],
    });
  }

  async function runStages() {
    const ids = [...picked];
    if (!ids.length) {
      setStageErr('请至少勾选一个阶段');
      return;
    }
    setStageErr('');
    setBusy('正在提交所选阶段…');
    try {
      const r = await api.post('/api/projects/' + projectId + '/stages', { stages: ids, chapter: chapter ? chapter.title : '' });
      if (r.warns && r.warns.length) toast.warn(r.warns.join('\n'));
      setPicked(new Set());
      const labels = ids.map((i) => (stageList.find((s) => s.id === i) || {}).label || i).join('、');
      submittedToast('已提交阶段：' + labels + '（待办数变化会实时刷新）');
      onRefresh && onRefresh();
    } catch (e) {
      setStageErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function startRun() {
    if (!chapter) return;
    setBusy('正在提交「' + chapter.title + '」生成…');
    try {
      await onRun(chapter.title);
      submittedToast('已提交「' + chapter.title + '」生成，进度可在「运行日志」查看');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function stopRun() {
    setBusy('正在停止生成…');
    try {
      await onStop();
    } finally {
      setBusy(null);
    }
  }

  async function regenChapter(mode) {
    if (!chapter) return;
    const msg =
      mode === 'storyboard'
        ? '将清空「' + chapter.title + '」当前的分镜，按小说重新拆分分镜（只跑 LLM 文本，不生成图片 / 视频；素材保留）。确定继续？'
        : '将清空「' + chapter.title + '」已生成的视频，按现有分镜重新生成全部视频（分镜与素材保留）。确定继续？';
    if (!(await toast.confirm(msg, { danger: true }))) return;
    setBusy(mode === 'storyboard' ? '正在提交重新生成分镜…' : '正在提交重新生成视频…');
    try {
      await api.post('/api/projects/' + projectId + '/chapters/' + chapter.id + '/regenerate' + (mode === 'storyboard' ? '?mode=full' : ''));
      submittedToast('已重新生成「' + chapter.title + '」' + (mode === 'storyboard' ? '分镜' : '视频') + '并立即开始，进度可在「运行日志」查看');
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-2 sm:grid-cols-3">
        {runningChapter === chapter?.title ? (
          <Button variant="danger" size="md" onClick={stopRun}>
            <Square size={13} /> 停止本章
          </Button>
        ) : (
          <Button variant="primary" size="md" disabled={!chapter || running} onClick={startRun}>
            <Play size={13} /> 生成 / 继续
          </Button>
        )}
        <Button variant="secondary" size="md" disabled={!chapter || running} onClick={() => regenChapter('storyboard')}>
          <Layers size={13} /> 重新生成分镜
        </Button>
        <Button variant="secondary" size="md" disabled={!chapter || running} onClick={() => regenChapter('videos')}>
          <Film size={13} /> 重新生成视频
        </Button>
      </div>

      <p className="m-0 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
        点「生成 / 继续」会接着上次进度跑，已完成的内容自动跳过，中断或失败后可继续。
        「重新生成分镜」只重跑 LLM 文本；「重新生成视频」保留分镜，仅重做本章视频。
      </p>

      <div className="hairline" />

      {stageList === null ? (
        stageLoadErr ? (
          <p className="m-0 text-[12px] text-[var(--danger)]">{stageLoadErr}</p>
        ) : (
          <div className="flex items-center justify-center gap-2.5 py-6 text-[12px] text-[var(--fg-3)]">
            <Spinner size={15} /> 分阶段运行加载中…
          </div>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <strong className="text-[12.5px] font-semibold text-[var(--fg)]">分阶段运行</strong>
            <span className="text-[10.5px] text-[var(--fg-4)]">可多选；任务之间自动串行</span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {stageList.map((s) => {
              const active = picked.has(s.id);
              const todo = pending[s.id] ? pending[s.id].todo : 0;
              const StageIcon = STAGE_ICON[s.id] || Layers;
              return (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  aria-disabled={running}
                  onClick={() => !running && toggleStage(s.id)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && !running) {
                      e.preventDefault();
                      toggleStage(s.id);
                    }
                  }}
                  className={
                    'flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-left transition-all duration-150 ' +
                    (running ? 'pointer-events-none opacity-50 ' : '') +
                    (active
                      ? 'border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]'
                      : 'border-[var(--line)] bg-white/[0.02] hover:border-[var(--line-strong)]')
                  }
                >
                  <span
                    className={
                      'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ' +
                      (active ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--line-strong)] bg-white/[0.04]')
                    }
                  >
                    {active ? <Check size={12} strokeWidth={3} className="text-[var(--accent-ink)]" /> : null}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <StageIcon size={12} className="text-[var(--fg-3)]" />
                      <span className="text-[12.5px] font-medium text-[var(--fg)]">{s.label}</span>
                      <Badge tone={todo ? 'accent' : 'neutral'}>待办 {todo}</Badge>
                    </span>
                    {s.desc ? <span className="text-[11px] leading-relaxed text-[var(--fg-3)]">{s.desc}</span> : null}
                  </span>
                </div>
              );
            })}
          </div>

          {stageErr ? <p className="m-0 text-[12px] text-[var(--danger)]">{stageErr}</p> : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="md" disabled={running || picked.size === 0} onClick={runStages}>
              <Play size={13} /> 运行所选阶段（{picked.size}）
            </Button>
            <Button variant="ghost" size="sm" disabled={running} onClick={() => setPicked(new Set(stageList.map((s) => s.id)))}>
              全选阶段
            </Button>
            {picked.size ? (
              <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>
                清空
              </Button>
            ) : null}
          </div>

          <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
            建议先跑「LLM 创作」把文本写对，再跑渲染阶段。待办数由后端统计、不消耗 LLM；视频生成耗时较长，启动前先检查分镜与素材。
          </p>
        </div>
      )}

      <BusyOverlay show={!!busy} text={busy} />
    </div>
  );
}
