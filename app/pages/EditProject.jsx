'use client';
import { useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Select, SelectItem } from '@heroui/react';
import { api } from '../api-client.js';
import { VIDEO_RESOLUTIONS, VIDEO_RATIOS, STYLE_OPTIONS, STYLE_CUSTOM, resolveStyle, splitStyle, selectKeys, pickKey } from './shared';
import { useToast } from '../toast';

// ============ 项目设置（名称/风格） ============
export default function EditProject({ project, onClose, onSaved }) {
  const toast = useToast();
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
      toast.success('已保存'); onClose(); onSaved();
    }
    catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  }
  return (
    <Modal isOpen size="lg" backdrop="blur" onClose={onClose}>
      <ModalContent>
        {() => (
          <>
            <ModalHeader>项目设置</ModalHeader>
            <ModalBody>
              <div className="row">
                <Input size="sm" label="项目名" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
                <Select size="sm" label="画面风格" className="flex-1" placeholder="选择画面风格（可选）" selectedKeys={selectKeys(styleSel)} onSelectionChange={(k) => setStyleSel(pickKey(k))}>
                  <SelectItem key="">选择画面风格（可选）</SelectItem>
                  {STYLE_OPTIONS.map((s) => <SelectItem key={s}>{s}</SelectItem>)}
                </Select>
              </div>
              {styleSel === STYLE_CUSTOM && (
                <Input size="sm" placeholder="请填写自定义风格" value={customStyle} onChange={(e) => setCustomStyle(e.target.value)} />
              )}
              <h3 className="text-base font-semibold" style={{ margin: '14px 0 6px' }}>视频参数</h3>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span className="muted">分辨率</span>
                <Select size="sm" className="w-36" aria-label="分辨率" selectedKeys={selectKeys(res)} onSelectionChange={(k) => setRes(pickKey(k))}>
                  {VIDEO_RESOLUTIONS.map(([v, l]) => <SelectItem key={v}>{l}</SelectItem>)}
                </Select>
                <span className="muted">比例</span>
                <Select size="sm" className="w-28" aria-label="比例" selectedKeys={selectKeys(ratio)} onSelectionChange={(k) => setRatio(pickKey(k))}>
                  {VIDEO_RATIOS.map((r) => <SelectItem key={r}>{r}</SelectItem>)}
                </Select>
                {res === 'custom' && (
                  <>
                    <span className="muted">宽</span>
                    <Input size="sm" type="number" min="64" step="32" value={cw} onChange={(e) => setCw(e.target.value)} placeholder="1024" className="w-24" />
                    <span className="muted">高</span>
                    <Input size="sm" type="number" min="64" step="32" value={ch} onChange={(e) => setCh(e.target.value)} placeholder="576" className="w-24" />
                  </>
                )}
              </div>
              <p className="muted" style={{ marginTop: 8 }}>章节与小说原文在「章节管理」页编辑；素材在「素材库」页管理（全项目共用）。</p>
            </ModalBody>
            <ModalFooter>
              <Button size="sm" color="primary" isDisabled={saving} onPress={save}>保存</Button>
              <Button size="sm" variant="flat" onPress={onClose}>取消</Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}