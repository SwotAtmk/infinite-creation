'use client';
import { useState, useEffect } from 'react';
import { Button, Checkbox, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import LoadingOverlay from './LoadingOverlay';

// ============ 章节操作面板（「操作」弹窗内容） ============
// 针对单个章节的生成/重生成/分阶段运行，替代原「生成内容」整页，重排版适配弹窗
export default function ChapterOps({ projectId, chapter, running, onRun, onStop, onRefresh, onGoLogs }) {
  const toast = useToast();
  // 分阶段运行：待办数由后端算（不启 LLM），勾选后单独起一批
  const [stageList, setStageList] = useState(null);
  const [pending, setPending] = useState({});
  const [picked, setPicked] = useState(() => new Set());
  const [stageErr, setStageErr] = useState('');
  // 提交类操作进行中：显示全屏加载层提示等待并阻断重复点击，操作结束（成功或失败）后自动消失
  const [busy, setBusy] = useState(null);

  // 待办数刷新：进入/离开运行态 + 运行期间每 4s 拉一次。
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/api/projects/' + projectId + '/stages')
      .then((d) => { if (alive) { setStageList(d.stages); setPending(d.pending || {}); } })
      .catch(() => {});
    load();
    if (!running) return () => { alive = false; };
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [projectId, running]);

  function toggleStage(id) {
    setPicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
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
    if (!ids.length) { setStageErr('请至少勾选一个阶段'); return; }
    setStageErr('');
    setBusy('正在提交所选阶段…');
    try {
      const r = await api.post('/api/projects/' + projectId + '/stages', { stages: ids, chapter: chapter ? chapter.title : '' });
      if (r.warns && r.warns.length) toast.open({ kind: 'warn', message: r.warns.join('\n') });
      setPicked(new Set());
      const labels = ids.map((i) => (stageList.find((s) => s.id === i) || {}).label || i).join('、');
      submittedToast('已提交阶段：' + labels + '（待办数变化会实时刷新）');
      onRefresh && onRefresh();
    } catch (e) { setStageErr(e.message); }
    finally { setBusy(null); }
  }

  async function startRun() {
    if (!chapter) return;
    setBusy('正在提交「' + chapter.title + '」生成…');
    try {
      await onRun(chapter.title);
      submittedToast('已提交「' + chapter.title + '」生成，进度可在「运行日志」查看');
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }
  async function stopRun() {
    setBusy('正在停止生成…');
    try { await onStop(); } finally { setBusy(null); }
  }
  async function regenChapter(mode) {
    if (!chapter) return;
    const msg = mode === 'storyboard'
      ? '将清空「' + chapter.title + '」当前的分镜，按小说重新拆分分镜（只跑 LLM 文本，不生成图片/视频；素材保留）。确定继续？'
      : '将清空「' + chapter.title + '」已生成的视频，按现有分镜重新生成全部视频（分镜与素材保留）。确定继续？';
    if (!(await toast.confirm(msg, { danger: true }))) return;
    setBusy(mode === 'storyboard' ? '正在提交重新生成分镜…' : '正在提交重新生成视频…');
    try {
      await api.post('/api/projects/' + projectId + '/chapters/' + chapter.id + '/regenerate' + (mode === 'storyboard' ? '?mode=full' : ''));
      submittedToast('已重新生成「' + chapter.title + '」' + (mode === 'storyboard' ? '分镜' : '视频') + '并立即开始，进度可在「运行日志」查看');
      onRefresh && onRefresh();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="row">
        {running
          ? <Button size="sm" color="danger" onPress={stopRun}>■ 停止</Button>
          : <Button size="sm" color="success" isDisabled={!chapter} onPress={startRun}>▶ 生成/继续 {chapter ? chapter.title : ''}</Button>}
        {!running && <Button size="sm" variant="flat" isDisabled={!chapter} onPress={() => regenChapter('storyboard')}>↻ 重新生成本章分镜</Button>}
        {!running && <Button size="sm" variant="flat" isDisabled={!chapter} onPress={() => regenChapter('videos')}>↻ 重新生成本章视频</Button>}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        点「生成/继续」就接着上次进度跑（已完成的素材/分镜/视频自动跳过），中断或失败后点它即可继续。
        「重新生成分镜」清空本章分镜、按小说重新拆分（只跑 LLM 文本，不出图/视频；素材保留）。
        「重新生成视频」保留分镜，只重做本章全部视频。
      </p>

      {stageList === null ? (
        <div className="border-t border-default-200 pt-3 flex items-center justify-center gap-2.5 py-6">
          <Spinner size="sm" />
          <span className="muted">分阶段运行加载中…</span>
        </div>
      ) : (
        <div className="border-t border-default-200 pt-3 flex flex-col gap-2">
          <div className="flex flex-col gap-2">
            <strong className="text-sm">分阶段运行</strong>
            <div className="row" style={{ gap: 14 }}>
              {stageList.map((s) => (
                <Checkbox
                  key={s.id}
                  size="sm"
                  isSelected={picked.has(s.id)}
                  isDisabled={running}
                  onValueChange={() => toggleStage(s.id)}
                  title={s.desc}
                >
                  <span className="flex items-center gap-1.5">
                    {s.label}
                    <span className="muted">待办 {pending[s.id] ? pending[s.id].todo : 0}</span>
                  </span>
                </Checkbox>
              ))}
            </div>
            <div className="row">
              <Button size="sm" color="primary" isDisabled={running || picked.size === 0} onPress={runStages}>
                ▶ 运行所选阶段（{picked.size}）
              </Button>
            </div>
          </div>
          {stageErr && <p className="m-0 text-danger">{stageErr}</p>}
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            建议按阶段拆分执行：勾「LLM 创作」只写文本（渲染工具已禁用），勾「资产图」「分镜视频」为渲染阶段；
            待办数由后端统计，不消耗 LLM。可以一次勾多个阶段或直接提交整条流水线，任务之间会自动串行，不会并发出图/出片。
            由于视频生成耗时较长，强烈建议在生成视频前先检查分镜与素材是否符合预期，再启动视频生成，避免素材不合格导致返工。
          </p>
        </div>
      )}

      <LoadingOverlay show={!!busy} text={busy} />
    </div>
  );
}
