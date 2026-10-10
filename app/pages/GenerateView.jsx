'use client';
import { useState, useEffect } from 'react';
import { Button, Select, SelectItem, Card, CardBody, Checkbox } from '@heroui/react';
import { api } from '../api-client.js';
import { selectKeys, pickKey } from './shared';
import { useToast } from '../toast';
import ShotsTab from './ShotsTab';
import LoadingOverlay from './LoadingOverlay';

// ============ 页2 · 生成内容 ============
export default function GenerateView({ projectId, chapters, cursor, setCursor, running, jobs = [], onRun, onStop, onRefresh, onGoLogs }) {
  const toast = useToast();
  const cur = chapters[cursor] || chapters[0] || null;
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
      const r = await api.post('/api/projects/' + projectId + '/stages', { stages: ids, chapter: cur ? cur.title : '' });
      if (r.warns && r.warns.length) toast.open({ kind: 'warn', message: r.warns.join('\n') });
      setPicked(new Set());
      const labels = ids.map((i) => (stageList.find((s) => s.id === i) || {}).label || i).join('、');
      submittedToast('已提交阶段：' + labels + '（待办数变化会实时刷新）');
      onRefresh();
    } catch (e) { setStageErr(e.message); }
    finally { setBusy(null); }
  }

  async function startRun(title) {
    if (!title) return;
    setBusy('正在提交「' + title + '」生成…');
    try {
      await onRun(title);
      submittedToast('已提交「' + title + '」生成，进度可在「运行日志」查看');
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }
  async function runAll() {
    setBusy('正在提交全部章节生成…');
    try { await onRun(null); } finally { setBusy(null); }
  }
  async function stopRun() {
    setBusy('正在停止生成…');
    try { await onStop(); } finally { setBusy(null); }
  }
  async function regenChapter(mode) {
    if (!cur) return;
    const msg = mode === 'storyboard'
      ? '将清空「' + cur.title + '」当前的分镜，重新拆分并生成全部视频（素材保留）。确定继续？'
      : '将清空「' + cur.title + '」已生成的视频，按现有分镜重新生成全部视频（分镜与素材保留）。确定继续？';
    if (!(await toast.confirm(msg, { danger: true }))) return;
    setBusy(mode === 'storyboard' ? '正在提交重新生成分镜…' : '正在提交重新生成视频…');
    try {
      await api.post('/api/projects/' + projectId + '/chapters/' + cur.id + '/regenerate' + (mode === 'storyboard' ? '?mode=full' : ''));
      submittedToast('已重新生成「' + cur.title + '」' + (mode === 'storyboard' ? '分镜' : '视频') + '并立即开始，进度可在「运行日志」查看');
      onRefresh();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(null); }
  }
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="gap-3">
          <div className="row">
            <h2 className="text-lg font-semibold m-0">生成内容</h2>
            <Select
              size="sm"
              className="w-56"
              aria-label="选择章节"
              selectedKeys={selectKeys(String(cursor))}
              onSelectionChange={(k) => setCursor(Number(pickKey(k)) || 0)}
            >
              {chapters.map((c, i) => <SelectItem key={String(i)}>{c.title}</SelectItem>)}
            </Select>
          </div>
          <div className="row">
            {running
              ? <Button size="sm" color="danger" onPress={stopRun}>■ 停止</Button>
              : <Button size="sm" color="success" isDisabled={!cur} onPress={() => cur && startRun(cur.title)}>▶ 生成/继续 {cur ? cur.title : ''}</Button>}
            {!running && <Button size="sm" variant="flat" onPress={runAll}>生成全部章节</Button>}
            {!running && <Button size="sm" variant="flat" isDisabled={!cur} onPress={() => regenChapter('storyboard')}>↻ 重新生成本章分镜</Button>}
            {!running && <Button size="sm" variant="flat" isDisabled={!cur} onPress={() => regenChapter('videos')}>↻ 重新生成本章视频</Button>}
          </div>
          <p className="muted">
            点「生成/继续」就接着上次进度跑（已完成的素材/分镜/视频自动跳过），中断或失败后点它即可继续。
            「重新生成分镜」清空本章分镜、重新拆分并出视频（素材保留）。
            「重新生成视频」保留分镜，只重做本章全部视频。
          </p>

          {stageList && (
            <div className="border-t border-default-200 pt-3 flex flex-col gap-2">
              <div className="row" style={{ gap: 14 }}>
                <strong className="text-sm">分阶段运行</strong>
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
                <Button size="sm" color="primary" isDisabled={running || picked.size === 0} onPress={runStages}>
                  ▶ 运行所选阶段（{picked.size}）
                </Button>
              </div>
              {stageErr && <p className="m-0 text-danger">{stageErr}</p>}
              <p className="muted" style={{ fontSize: 12 }}>
                受全部模型本地部署的硬件限制（显存有限），LLM 与 ComfyUI 不能同时运行，故按阶段拆分执行：勾「LLM 创作」只写文本（渲染工具已禁用），
                勾「资产图」「分镜视频」为渲染阶段，同一批不能混勾 LLM 与渲染项；待办数由后端统计，不消耗 LLM。
                由于视频生成耗时较长，强烈建议在生成视频前先检查分镜与素材是否符合预期，再启动视频生成，避免素材不合格导致返工。
              </p>
            </div>
          )}
        </CardBody>
      </Card>
      {cur && <ShotsTab projectId={projectId} chapter={cur.title} running={running} jobs={jobs} onRefresh={onRefresh} />}
      <LoadingOverlay show={!!busy} text={busy} />
    </div>
  );
}
