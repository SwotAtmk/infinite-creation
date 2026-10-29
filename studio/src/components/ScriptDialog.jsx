import { useState } from 'react';
import { FileText, Sparkles, Wand2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { Button, Field, Textarea } from './ui.jsx';
import { BusyOverlay, Modal } from './overlays.jsx';
import { useToast } from './toast.jsx';

// 章节剧本管理：查看/编辑/保存 + AI 生成/改写（AI 结果由后端直接落库）。
export default function ScriptDialog({ projectId, chapter, running, onRefresh, onClose }) {
  const toast = useToast();
  const initial = chapter.script || '';
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [instruction, setInstruction] = useState('');
  const [showNovel, setShowNovel] = useState(false);
  const [busy, setBusy] = useState(null);
  const dirty = text !== saved;
  const hasSaved = !!saved.trim();

  async function runAi(mode) {
    if (running) return;
    if (mode === 'generate' && hasSaved) {
      if (!(await toast.confirm('AI 会用本章原文重新生成剧本并覆盖现有内容，继续？', { danger: true }))) return;
    } else if (dirty) {
      if (!(await toast.confirm('AI 结果会覆盖当前未保存的修改，继续？'))) return;
    }
    setBusy(mode === 'rewrite' ? 'AI 正在改写剧本…' : 'AI 正在生成剧本…');
    try {
      const r = await api.post('/api/projects/' + projectId + '/chapters/' + chapter.id + '/script', {
        mode,
        instruction: mode === 'rewrite' ? instruction : '',
      });
      setText(r.script || '');
      setSaved(r.script || '');
      toast.success(mode === 'rewrite' ? 'AI 已改写并保存剧本' : 'AI 已生成并保存剧本');
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (running || !dirty) return;
    setBusy('正在保存剧本…');
    try {
      const c = await api.patch('/api/projects/' + projectId + '/chapters/' + chapter.id, { script: text });
      const next = c && c.script != null ? c.script : text;
      setText(next);
      setSaved(next);
      toast.success('剧本已保存');
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={'章节剧本 · ' + chapter.title}
      description="剧本是拆分镜的剧情蓝本；AI 生成/改写会自动保存。"
      size="xl"
      footer={
        <>
          <Button variant="ghost" size="md" disabled={!!busy} onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" size="md" loading={!!busy} disabled={running || !dirty || !!busy} onClick={save}>
            保存剧本
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--fg-3)]">
            <FileText size={12} className="opacity-70" />
            {hasSaved ? '已有剧本' : '待生成'}
            <span className="text-[var(--fg-4)]">· {text.length.toLocaleString()} 字</span>
          </span>
          <Button variant="ghost" size="xs" onClick={() => setShowNovel((v) => !v)}>
            {showNovel ? '收起本章原文' : '查看本章原文'}
          </Button>
        </div>

        {showNovel ? (
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--line)] bg-black/20 p-3 text-[12px] leading-relaxed text-[var(--fg-3)]">
            {chapter.novel ? chapter.novel : '本章还没有小说原文。'}
          </div>
        ) : null}

        {running ? (
          <p className="m-0 text-[11.5px] leading-relaxed text-[var(--accent)]">本章正在生成，运行中不可修改剧本。</p>
        ) : null}

        <Field label="剧本正文">
          <Textarea
            rows={18}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="在这里编写剧本：【第1场｜夜｜街口】……（也可以点下方 AI 生成）"
            className="min-h-[320px] font-mono text-[12.5px] leading-relaxed"
          />
        </Field>

        <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-white/[0.02] p-3.5">
          <div className="flex flex-col gap-0.5">
            <strong className="text-[12.5px] font-semibold text-[var(--fg)]">AI 剧本</strong>
            <span className="text-[11px] leading-relaxed text-[var(--fg-4)]">生成或改写后直接保存，可在上方继续手动调整。</span>
          </div>
          <Button variant="primary" size="sm" disabled={running || !!busy} onClick={() => runAi('generate')}>
            <Sparkles size={13} /> AI 生成剧本
          </Button>
          <Field label="改写要求" hint={hasSaved ? undefined : '先保存一版剧本，才能按指令改写。'}>
            <Textarea
              rows={2}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="例如：节奏更紧凑、增加一处反转、台词更口语化…"
            />
          </Field>
          <Button variant="secondary" size="sm" disabled={running || !!busy || !hasSaved} onClick={() => runAi('rewrite')}>
            <Wand2 size={13} /> AI 改写
          </Button>
        </div>
      </div>

      <BusyOverlay show={!!busy} text={busy} />
    </Modal>
  );
}
