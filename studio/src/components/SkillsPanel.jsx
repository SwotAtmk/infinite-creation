import { useCallback, useEffect, useRef, useState } from 'react';
import { FileUp, RefreshCw, Sparkles } from 'lucide-react';
import { api, uploadBinary } from '../lib/api.js';
import { Badge, Button, EmptyState } from './ui.jsx';
import { useToast } from './toast.jsx';

export default function SkillsPanel() {
  const toast = useToast();
  const [skills, setSkills] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const fileRef = useRef(null);

  const load = useCallback(
    () =>
      api
        .get('/api/skills')
        .then(setSkills)
        .catch((e) => toast.error(e.message))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  async function rescan() {
    try {
      await api.post('/api/skills/rescan');
      load();
      toast.success('已重新扫描 skills/');
    } catch (e) {
      toast.error('重新扫描失败：' + e.message);
    }
  }

  async function upload(file) {
    if (!file) return;
    setUploading(true);
    try {
      const r = await uploadBinary('/api/skills/upload', file, 'application/zip');
      toast.success('已安装技能：' + (r.installed || []).map((s) => s.name).join('、'));
      load();
    } catch (e) {
      toast.error('上传失败：' + e.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-[var(--fg-4)]">已安装 {skills.length} 个技能 · 全局，所有项目共用</span>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
            <FileUp size={13} /> {uploading ? '上传中…' : '上传技能包（zip）'}
          </Button>
          <Button variant="ghost" size="sm" onClick={rescan}>
            <RefreshCw size={13} /> 重新扫描
          </Button>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          e.target.value = '';
          if (f) upload(f);
        }}
      />

      {loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-12 rounded-lg" />
          ))}
        </div>
      ) : skills.length ? (
        <div className="flex flex-col divide-y divide-[var(--line)] rounded-xl border border-[var(--line)] bg-white/[0.015]">
          {skills.map((s) => (
            <div key={s.id} className="flex items-start gap-3 px-3.5 py-2.5">
              <Sparkles size={13} className="mt-0.5 shrink-0 text-[var(--fg-4)]" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] font-medium text-[var(--fg-2)]">{s.name}</span>
                  <Badge tone="neutral">{s.source}</Badge>
                </div>
                {s.description ? <p className="m-0 mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[var(--fg-3)]">{s.description}</p> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={Sparkles} title="暂无技能" description="把 SKILL.md 目录放进 skills/ 后重新扫描，或上传 zip 技能包。" />
      )}

      <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
        技能会扩展 Agent 在写剧本、分镜与提示词阶段的能力；上传的技能包会解压到 skills/ 目录。
      </p>
    </div>
  );
}
