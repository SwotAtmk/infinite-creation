'use client';
import { useRef, useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Select, SelectItem } from '@heroui/react';
import { api } from '../api-client.js';
import { fileUrl, selectKeys, pickKey } from './shared';
import { useToast } from '../toast';

const LABEL = { character: '角色', scene: '场景', prop: '道具', costume: '服装', age: '年龄', audio: '音频' };
const AUDIO_CATEGORIES = ['voice', 'music', 'sfx'];

export default function ShotMaterialPicker({ projectId, assets, category, mode, replaceAssetId, assignedIds = [], charIds = [], onPick, onCancel }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const isAudio = category === 'audio';
  // 服装/年龄是挂在角色下的变体：上传新素材时必须指定所属角色（否则生成时被静默忽略）。
  // 优先给本镜已绑定的角色，只有一个就直接用它；多个/没有则让用户选。
  const isVariant = category === 'costume' || category === 'age';
  const characters = (assets || []).filter((a) => a.category === 'character');
  const shotChars = (charIds || []).map((id) => characters.find((c) => c.id === id)).filter(Boolean);
  const parentChoices = shotChars.length ? shotChars : characters;
  const [parentId, setParentId] = useState(() => (isVariant && parentChoices.length === 1 ? parentChoices[0].id : ''));
  const list = (assets || []).filter((a) => (isAudio ? AUDIO_CATEGORIES.includes(a.category) : a.category === category));
  const disabledIds = (assignedIds || []).filter((id) => id !== replaceAssetId);

  async function upload(file) {
    const name = await toast.prompt('新素材名称', { defaultValue: (file.name || '').replace(/\.[^.]+$/, ''), placeholder: '素材名称' });
    if (!name) return;
    if (isVariant && !parentId) { toast.error('请先选择该服装/年龄变体所属的角色'); return; }
    setBusy(true);
    try {
      const assetCategory = isAudio ? 'voice' : category;
      const a = await api.post('/api/projects/' + projectId + '/assets', isVariant ? { category: assetCategory, name, parent_id: parentId } : { category: assetCategory, name });
      const buf = await file.arrayBuffer();
      const res = await fetch('/api/projects/' + projectId + '/assets/' + a.id + '/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        body: buf,
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + res.status)); }
      onPick(a.id);
    } catch (e) { toast.error('上传失败：' + e.message); setBusy(false); }
  }

  return (
    <Modal isOpen size="lg" backdrop="blur" onClose={onCancel}>
      <ModalContent>
        {() => (
          <>
            <ModalHeader>{(LABEL[category] || category) + ' · ' + (mode === 'replace' ? '替换' : '添加')}</ModalHeader>
            <ModalBody>
              <div className="row justify-between">
                <span className="muted">从素材库选择已有「{LABEL[category] || category}」，或上传新{isAudio ? '音频' : '图'}</span>
                <Button size="sm" isDisabled={busy || (isVariant && !parentChoices.length)} onPress={() => fileRef.current && fileRef.current.click()}>＋ 上传新素材</Button>
              </div>
              {isVariant && (
                <Select size="sm" label="所属角色（上传新素材时必须指定）" selectedKeys={selectKeys(parentId)} onSelectionChange={(k) => setParentId(pickKey(k))}>
                  {parentChoices.map((c) => <SelectItem key={c.id}>{c.name}</SelectItem>)}
                </Select>
              )}
              {isVariant && !parentChoices.length && <p className="muted" style={{ margin: 0 }}>该分镜还没有角色：请先给本镜绑定角色，或在「素材库」新建角色后再上传服装/年龄变体。</p>}
              <input ref={fileRef} type="file" accept={isAudio ? 'audio/*' : 'image/*'} style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) upload(f); }} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10, maxHeight: 320, overflow: 'auto' }}>
                {list.map((a) => {
                  const disabled = disabledIds.includes(a.id);
                  const pick = () => !disabled && !busy && onPick(a.id);
                  return (
                    <div key={a.id} style={{ textAlign: 'center', opacity: disabled ? 0.4 : 1 }}>
                      {isAudio
                        ? (a.audio_path || a.voice_ref
                            ? <audio controls src={fileUrl(projectId, a.audio_path || a.voice_ref)} style={{ width: '100%', height: 38 }} />
                            : <div className="thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 38 }}>音频</div>)
                        : (a.image_path
                            ? <img className="thumb" src={fileUrl(projectId, a.image_path)} onClick={pick} style={{ cursor: disabled ? 'not-allowed' : 'pointer' }} title={disabled ? '已在该分镜中使用' : '点击选择'} />
                            : <div className="thumb" onClick={pick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: disabled ? 'not-allowed' : 'pointer' }}>{LABEL[category]}</div>)}
                      <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all', ...(isAudio ? { cursor: disabled ? 'not-allowed' : 'pointer', textDecoration: 'underline' } : {}) }} onClick={isAudio ? pick : undefined}>{a.name}{disabled ? '（已使用）' : ''}</div>
                    </div>
                  );
                })}
                {!list.length && <p className="muted" style={{ gridColumn: '1 / -1' }}>素材库暂无「{LABEL[category] || category}」素材，可上传新{isAudio ? '音频' : '图'}。</p>}
              </div>
            </ModalBody>
            <ModalFooter>
              <Button size="sm" variant="flat" isDisabled={busy} onPress={onCancel}>取消</Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}