import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '../lib/api.js';
import { STYLE_OPTIONS, STYLE_CUSTOM, resolveStyle, splitStyle, VIDEO_RESOLUTION_CUSTOM } from '../lib/shared.js';
import { RESOLUTION_SELECT_ITEMS, RATIO_SELECT_ITEMS } from './visuals.jsx';
import { Button, Field, Input, Select, Switch } from './ui.jsx';
import { FormSection, Modal } from './overlays.jsx';
import { useToast } from './toast.jsx';

export default function ProjectSettingsDialog({ open, onOpenChange, project, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [styleSel, setStyleSel] = useState('');
  const [customStyle, setCustomStyle] = useState('');
  const [res, setRes] = useState('480P');
  const [ratio, setRatio] = useState('16:9');
  const [cw, setCw] = useState('');
  const [ch, setCh] = useState('');
  const [enableBgm, setEnableBgm] = useState(true);
  const [enableSub, setEnableSub] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    const init = splitStyle(project.style);
    setName(project.name || '');
    setStyleSel(init.sel);
    setCustomStyle(init.custom);
    setRes(project.video_resolution || '480P');
    setRatio(project.video_aspect_ratio || '16:9');
    setCw(project.video_width ? String(project.video_width) : '');
    setCh(project.video_height ? String(project.video_height) : '');
    setEnableBgm(project.enable_bgm !== false);
    setEnableSub(project.enable_subtitles !== false);
  }, [open, project]);

  async function save() {
    setSaving(true);
    try {
      await api.patch('/api/projects/' + project.id, {
        name: name.trim(),
        style: resolveStyle(styleSel, customStyle),
        video_resolution: res,
        video_aspect_ratio: ratio,
        video_width: Number(cw) || 0,
        video_height: Number(ch) || 0,
        enable_bgm: enableBgm,
        enable_subtitles: enableSub,
      });
      toast.success('项目设置已保存');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      title="项目设置"
      description="修改项目名、画面风格与成片参数；章节与素材在各自页面管理。"
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="md" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" size="md" loading={saving} disabled={!name.trim() || saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <FormSection index="01" title="基本信息">
          <Field label="项目名" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="画面风格">
            <div className="flex flex-wrap gap-1.5">
              <StyleChip active={styleSel === ''} onClick={() => setStyleSel('')}>
                不指定
              </StyleChip>
              {STYLE_OPTIONS.map((s) => (
                <StyleChip key={s} active={styleSel === s} onClick={() => setStyleSel(s)}>
                  {s}
                </StyleChip>
              ))}
            </div>
          </Field>
          {styleSel === STYLE_CUSTOM ? (
            <Input value={customStyle} onChange={(e) => setCustomStyle(e.target.value)} placeholder="请填写自定义风格" />
          ) : null}
        </FormSection>

        <div className="hairline" />

        <FormSection index="02" title="视频参数">
          <div className="grid grid-cols-2 gap-3">
            <Field label="分辨率">
              <Select value={res} onChange={setRes} items={RESOLUTION_SELECT_ITEMS} />
            </Field>
            <Field label="宽高比">
              <Select value={ratio} onChange={setRatio} items={RATIO_SELECT_ITEMS} />
            </Field>
          </div>
          {res === VIDEO_RESOLUTION_CUSTOM ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="宽度（px）">
                <Input type="number" min="64" step="32" value={cw} onChange={(e) => setCw(e.target.value)} placeholder="1024" />
              </Field>
              <Field label="高度（px）">
                <Input type="number" min="64" step="32" value={ch} onChange={(e) => setCh(e.target.value)} placeholder="576" />
              </Field>
            </div>
          ) : null}
          <div className="flex flex-col gap-3 pt-1">
            <Switch
              checked={enableBgm}
              onChange={setEnableBgm}
              label="自动生成背景音乐"
              hint="开启后，视频阶段会自动生成纯音乐并合成到成片。"
            />
            <Switch
              checked={enableSub}
              onChange={setEnableSub}
              label="自动添加字幕"
              hint="导出 / 合并成片时把分镜台词与旁白烧录进画面（不显示角色名）。"
            />
          </div>
        </FormSection>
      </div>
    </Modal>
  );
}

function StyleChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded-full border px-3 py-1.5 text-[12px] transition-all duration-150',
        active
          ? 'border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]'
          : 'border-[var(--line)] bg-white/[0.02] text-[var(--fg-3)] hover:border-[var(--line-strong)] hover:text-[var(--fg-2)]',
      )}
    >
      {children}
    </button>
  );
}
