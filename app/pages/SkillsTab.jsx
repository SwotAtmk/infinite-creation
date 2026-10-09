'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { Card, CardBody, Button, Chip } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';

// ============ 技能 ============
export default function SkillsTab() {
  const toast = useToast();
  const [skills, setSkills] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const load = useCallback(() => api.get('/api/skills').then(setSkills).catch((e) => toast.error(e.message)), []);
  useEffect(() => { load(); }, [load]);
  async function rescan() { await api.post('/api/skills/rescan'); load(); }
  function pickZip() { if (fileRef.current) fileRef.current.click(); }
  async function doUploadZip(file) {
    if (!file) return;
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch('/api/skills/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'X-Filename': encodeURIComponent(file.name) },
        body: buf,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
      toast.success('已安装技能：' + (j.installed || []).map((s) => s.name).join('、'));
      load();
    } catch (e) { toast.error('上传失败：' + e.message); }
    finally { setUploading(false); }
  }
  return (
    <Card shadow="none" className="border border-default-200">
      <CardBody className="gap-2">
        <div className="row justify-between">
          <h2 className="m-0">已安装技能（{skills.length}）</h2>
          <div className="row">
            <Button size="sm" isDisabled={uploading} onPress={pickZip}>{uploading ? '上传中…' : '上传技能包 (zip)'}</Button>
            <Button size="sm" variant="flat" onPress={rescan}>重新扫描 skills/</Button>
          </div>
        </div>
        {skills.map((s) => (
          <div key={s.id} className="row justify-between py-2 border-b border-default-100">
            <div>
              <b>{s.name}</b> <Chip size="sm" variant="flat">{s.source}</Chip>
              <div className="muted">{s.description}</div>
            </div>
          </div>
        ))}
        <input ref={fileRef} type="file" accept=".zip,application/zip,application/x-zip-compressed" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) doUploadZip(f); e.target.value = ''; }} />
        <p className="muted" style={{ marginTop: 12 }}>把 SKILL.md 目录丢进 skills/ 再「重新扫描」即可扩展；或点「上传技能包」上传 zip 压缩包批量安装技能。</p>
      </CardBody>
    </Card>
  );
}