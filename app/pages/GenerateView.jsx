'use client';
import { useState, useEffect } from 'react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import ShotsTab from './ShotsTab';

// ============ 页2 · 生成内容 ============
export default function GenerateView({ projectId, chapters, cursor, setCursor, running, onRun, onStop, onRefresh, onGoLogs }) {
  const toast = useToast();
  const cur = chapters[cursor] || chapters[0] || null;
  // 分阶段运行：待办数由后端算（不启 LLM），勾选后单独起一批
  const [stageList, setStageList] = useState(null);
  const [pending, setPending] = useState({});
  const [picked, setPicked] = useState(() => new Set());
  const [stageErr, setStageErr] = useState('');

  // 待办数刷新：进入/离开运行态 + 运行期间每 4s 拉一次。
  // 不这么做的话，阶段跑完后数字还是旧的，只能靠整页刷新恢复（这是本次修的 UI 痛点）。
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
    try {
      const r = await api.post('/api/projects/' + projectId + '/stages', { stages: ids, chapter: cur ? cur.title : '' });
      if (r.warns && r.warns.length) toast.open({ kind: 'warn', message: r.warns.join('\n') });
      setPicked(new Set());
      const labels = ids.map((i) => (stageList.find((s) => s.id === i) || {}).label || i).join('、');
      submittedToast('已提交阶段：' + labels + '（待办数变化会实时刷新）');
      onRefresh();
    } catch (e) { setStageErr(e.message); }
  }

  async function startRun(title) {
    if (!title) return;
    try {
      await onRun(title);
      submittedToast('已提交「' + title + '」生成，进度可在「运行日志」查看');
    } catch (e) { toast.error(e.message); }
  }
  async function regenChapter(mode) {
    if (!cur) return;
    const msg = mode === 'storyboard'
      ? '将清空「' + cur.title + '」当前的分镜，重新拆分并生成全部视频（素材保留）。确定继续？'
      : '将清空「' + cur.title + '」已生成的视频，按现有分镜重新生成全部视频（分镜与素材保留）。确定继续？';
    if (!(await toast.confirm(msg, { danger: true }))) return;
    try {
      await api.post('/api/projects/' + projectId + '/chapters/' + cur.id + '/regenerate' + (mode === 'storyboard' ? '?mode=full' : ''));
      submittedToast('已重新生成「' + cur.title + '」' + (mode === 'storyboard' ? '分镜' : '视频'));
    } catch (e) { toast.error(e.message); }
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

        {stageList && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #2a2f3a' }}>
            <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13 }}>分阶段运行</strong>
              {stageList.map((s) => (
                <label key={s.id} title={s.desc} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: running ? 'not-allowed' : 'pointer' }}>
                  <input type="checkbox" checked={picked.has(s.id)} disabled={running} onChange={() => toggleStage(s.id)} />
                  <span>{s.label}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    待办 {pending[s.id] ? pending[s.id].todo : 0}
                  </span>
                </label>
              ))}
              <button className="primary" disabled={running || picked.size === 0} onClick={runStages}>
                ▶ 运行所选阶段（{picked.size}）
              </button>
            </div>
            {stageErr && <p style={{ margin: '8px 0 0', color: '#e5534b' }}>{stageErr}</p>}
            <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
              受全部模型本地部署的硬件限制（显存有限），LLM 与 ComfyUI 不能同时运行，故按阶段拆分执行：勾「LLM 创作」只写文本（渲染工具已禁用），
              勾「资产图」「分镜视频」为渲染阶段，同一批不能混勾 LLM 与渲染项；待办数由后端统计，不消耗 LLM。
              注意：ComfyUI 的 --use-ck-attention 启动参数与 Qwen-Image 2 存在兼容性问题（生图质量异常、超长提示词丢失），
              生图需使用未开启 CK 的 ComfyUI 实例。
              由于视频生成耗时较长，强烈建议在生成视频前先检查分镜与素材是否符合预期，再启动视频生成，避免素材不合格导致返工。
            </p>
          </div>
        )}
      </div>
      {cur && <ShotsTab projectId={projectId} chapter={cur.title} running={running} onRefresh={onRefresh} />}
    </div>
  );
}