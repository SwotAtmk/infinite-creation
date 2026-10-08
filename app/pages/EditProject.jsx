'use client';
import { useState } from 'react';
import { api } from '../api-client.js';
import { VIDEO_RESOLUTIONS, VIDEO_RATIOS, STYLE_OPTIONS, STYLE_CUSTOM, resolveStyle, splitStyle } from './shared';

// ============ 项目设置（名称/风格） ============
export default function EditProject({ project, onClose, onSaved }) {
  const initStyle = splitStyle(project.style);
  const [name, setName] = useState(project.name);
  const [styleSel, setStyleSel] = useState(initStyle.sel);
  const [customStyle, setCustomStyle] = useState(initStyle.custom);
  const [res, setRes] = useState(project.video_resolution || '480P');
  const [ratio, setRatio] = useState(project.video_aspect_ratio || '16:9');
  const [cw, setCw] = useState(project.video_width ? String(project.video_width) : '');
  const [ch, setCh] = useState(project.video_height ? String(project.video_height) : '');
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      await api.patch('/api/projects/' + project.id, {
        name, style: resolveStyle(styleSel, customStyle),
        video_resolution: res,
        video_aspect_ratio: ratio,
        video_width: Number(cw) || 0,
        video_height: Number(ch) || 0,
      });
      alert('已保存'); onClose(); onSaved();
    }
    catch (e) { alert(e.message); }
    finally { setSaving(false); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>项目设置</h2>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="项目名" style={{ flex: 1 }} />
          <select value={styleSel} onChange={(e) => setStyleSel(e.target.value)} style={{ flex: 1 }}>
            <option value="">选择画面风格（可选）</option>
            {STYLE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {styleSel === STYLE_CUSTOM && (
          <input placeholder="请填写自定义风格" value={customStyle} onChange={(e) => setCustomStyle(e.target.value)} style={{ flex: 1, marginTop: 8 }} />
        )}
        <h3 style={{ margin: '14px 0 6px' }}>视频参数</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span className="muted">分辨率</span>
          <select value={res} onChange={(e) => setRes(e.target.value)}>
            {VIDEO_RESOLUTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <span className="muted">比例</span>
          <select value={ratio} onChange={(e) => setRatio(e.target.value)}>
            {VIDEO_RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {res === 'custom' && (
            <>
              <span className="muted">宽</span>
              <input type="number" min="64" step="32" value={cw} onChange={(e) => setCw(e.target.value)} placeholder="1024" style={{ width: 90 }} />
              <span className="muted">高</span>
              <input type="number" min="64" step="32" value={ch} onChange={(e) => setCh(e.target.value)} placeholder="576" style={{ width: 90 }} />
            </>
          )}
        </div>
        <p className="muted" style={{ marginTop: 8 }}>章节与小说原文在「章节管理」页编辑；素材在「素材库」页管理（全项目共用）。</p>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={saving} onClick={save}>保存</button>
          <button onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}