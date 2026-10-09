'use client';
import { useRef, useState } from 'react';
import { Card, CardBody, Button, Input, Select, SelectItem, Modal, ModalContent, ModalBody, ModalFooter } from '@heroui/react';
import { CATEGORIES, fileUrl, selectKeys, pickKey } from './shared';

// ============ 参考图片素材列表（统一：已上传素材 + 待上传本地文件） ============
// items: 待上传的本地文件 [{ key, file, mode: 'reference'|'library', category, description, previewUrl }]
// onChange(items): 待上传项变化后回传最新列表
// saved: 已上传的参考素材 [{ id, name, image_path, mode, category, description }]（可编辑）
// onUpdateSaved(id, patch): 编辑某条已上传素材（mode / category / description）
// onDeleteSaved(id): 删除某条已上传素材
let seq = 0;
function nextKey() { seq += 1; return 'ref_' + Date.now() + '_' + seq; }

export default function ReferencePicker({ projectId, items, onChange, saved = [], onUpdateSaved, onDeleteSaved, allowAdd = true }) {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(null); // { url, name } 点击放大预览

  function addFiles(fileList) {
    const next = [];
    for (const file of fileList || []) {
      if (!file.type || !file.type.startsWith('image/')) continue;
      next.push({ key: nextKey(), file, mode: 'reference', category: 'other', description: '', previewUrl: URL.createObjectURL(file) });
    }
    if (next.length) onChange([...(items || []), ...next]);
  }

  function patch(key, p) {
    onChange((items || []).map((it) => (it.key === key ? { ...it, ...p } : it)));
  }
  function remove(key) {
    onChange((items || []).filter((it) => it.key !== key));
  }

  const savedList = saved || [];
  const pendingList = items || [];
  const hasAny = savedList.length > 0 || pendingList.length > 0;

  return (
    <>
      <Card shadow="none" className="border border-default-200 mt-2.5">
        <CardBody className="gap-2 p-2.5">
          <div className="row justify-between">
            <b className="m-0">参考图片素材（可选）</b>
            {allowAdd && <Button size="sm" onPress={() => fileRef.current && fileRef.current.click()}>＋ 选择参考图片</Button>}
          </div>
          <p className="muted" style={{ marginTop: 4 }}>
            「参考生成新素材」会提交给视觉模型分析后据此生成新素材；「导入素材库」直接加入素材库。用途描述可随时编辑，点击缩略图可放大预览。
          </p>
          {allowAdd && (
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => { addFiles(e.target.files || []); e.target.value = ''; }}
            />
          )}
          {hasAny && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {savedList.map((r) => (
                <div key={'saved_' + r.id} className="border border-default-200 rounded-md p-2">
                  <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                    {r.image_path
                      ? <img src={fileUrl(projectId, r.image_path)} alt="" onClick={() => setPreview({ url: fileUrl(projectId, r.image_path), name: r.name })} className="w-12 h-12 object-cover rounded cursor-zoom-in" title="点击放大" />
                      : <div className="thumb w-12 h-12 flex items-center justify-center rounded" style={{ aspectRatio: '1 / 1' }}>图</div>}
                    <span style={{ flex: 1, wordBreak: 'break-all' }}>{r.name || '未命名'}</span>
                    <Select size="sm" className="w-40 min-w-0" aria-label="素材用途" selectedKeys={selectKeys(r.mode)} onSelectionChange={(k) => onUpdateSaved && onUpdateSaved(r.id, { mode: pickKey(k) })}>
                      <SelectItem key="reference">参考生成新素材</SelectItem>
                      <SelectItem key="library">导入素材库</SelectItem>
                    </Select>
                    {r.mode === 'library' && (
                      <Select size="sm" className="w-28 min-w-0" aria-label="素材分类" selectedKeys={selectKeys(r.category)} onSelectionChange={(k) => onUpdateSaved && onUpdateSaved(r.id, { category: pickKey(k) })}>
                        {CATEGORIES.map(([k, l]) => <SelectItem key={k}>{l}</SelectItem>)}
                      </Select>
                    )}
                    {onDeleteSaved && <Button size="sm" variant="flat" color="danger" onPress={() => onDeleteSaved(r.id)}>删除</Button>}
                  </div>
                  <Input
                    size="sm"
                    defaultValue={r.description || ''}
                    onBlur={(e) => { const v = e.target.value || ''; if (v !== (r.description || '')) onUpdateSaved && onUpdateSaved(r.id, { description: v }); }}
                    placeholder="用途 / 用于剧情哪部分（可选，提交给 Agent 参考）"
                    className="mt-1.5"
                  />
                </div>
              ))}
              {pendingList.map((it) => (
                <div key={it.key} className="border border-default-200 rounded-md p-2">
                  <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                    <img src={it.previewUrl} alt="" onClick={() => setPreview({ url: it.previewUrl, name: it.file.name })} className="w-12 h-12 object-cover rounded cursor-zoom-in" title="点击放大" />
                    <span style={{ flex: 1, wordBreak: 'break-all' }}>{it.file.name}</span>
                    <Select size="sm" className="w-40 min-w-0" aria-label="素材用途" selectedKeys={selectKeys(it.mode)} onSelectionChange={(k) => patch(it.key, { mode: pickKey(k) })}>
                      <SelectItem key="reference">参考生成新素材</SelectItem>
                      <SelectItem key="library">导入素材库</SelectItem>
                    </Select>
                    {it.mode === 'library' && (
                      <Select size="sm" className="w-28 min-w-0" aria-label="素材分类" selectedKeys={selectKeys(it.category)} onSelectionChange={(k) => patch(it.key, { category: pickKey(k) })}>
                        {CATEGORIES.map(([k, l]) => <SelectItem key={k}>{l}</SelectItem>)}
                      </Select>
                    )}
                    <Button size="sm" variant="flat" onPress={() => remove(it.key)}>移除</Button>
                  </div>
                  <Input
                    size="sm"
                    value={it.description || ''}
                    onChange={(e) => patch(it.key, { description: e.target.value })}
                    placeholder="用途 / 用于剧情哪部分（可选，提交给 Agent 参考）"
                    className="mt-1.5"
                  />
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
      <Modal isOpen={!!preview} size="5xl" backdrop="opaque" onClose={() => setPreview(null)}>
        <ModalContent>
          {() => (
            <>
              <ModalBody className="items-center py-6">
                <img src={preview && preview.url} alt={preview ? preview.name || '' : ''} className="max-w-full max-h-[86vh] object-contain rounded-lg" />
                {preview && preview.name && <div className="mt-3 text-sm">{preview.name}</div>}
              </ModalBody>
              <ModalFooter>
                <Button size="sm" variant="flat" onPress={() => setPreview(null)}>关闭</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}