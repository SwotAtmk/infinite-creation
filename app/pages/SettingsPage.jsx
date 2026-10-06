'use client';
import { useEffect, useState } from 'react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import SkillsTab from './SkillsTab';
import WorkflowsTab from './WorkflowsTab';

// ============ 设置 ============
export default function SettingsPage({ onBack }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [test, setTest] = useState('');
  useEffect(() => { api.get('/api/config').then(setCfg).catch((e) => toast.error(e.message)); }, []);
  async function save() {
    try { await api.put('/api/config', cfg); toast.success('已保存'); } catch (e) { toast.error(e.message); }
  }
  async function testComfy() {
    try { const r = await api.post('/api/comfyui/test', { baseUrl: cfg.comfyui.baseUrl }); setTest(r.ok ? ('连接成功 · ' + r.system + ' · ' + r.device) : ('连接失败：' + r.error)); } catch (e) { setTest('失败：' + e.message); }
  }
  if (!cfg) return <div className="muted">加载中…</div>;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}><h2>设置</h2><button onClick={onBack}>返回</button></div>
      <h3>ComfyUI 服务</h3>
      <div className="row">
        <input style={{ flex: 1 }} value={cfg.comfyui.baseUrl} onChange={(e) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, baseUrl: e.target.value } })} />
        <button onClick={testComfy}>测试连接</button>
        {test && <span className="muted">{test}</span>}
      </div>
      <h3>LLM（Agent 大脑，OpenAI 兼容）</h3>
      <div className="row">
        <input style={{ flex: 2 }} placeholder="Base URL（需 /v1 结尾）" value={cfg.llm.baseUrl} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, baseUrl: e.target.value } })} />
        <input style={{ flex: 1 }} placeholder="模型" value={cfg.llm.model} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, model: e.target.value } })} />
      </div>
      <br />
      <input style={{ width: '100%' }} placeholder="API Key" type="password" value={cfg.llm.apiKey} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, apiKey: e.target.value } })} />
      <label className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={!!cfg.llm.vision} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, vision: e.target.checked } })} />
        <span>支持图片输入（多模态/视觉模型）</span>
      </label>
      <p className="muted" style={{ marginTop: 4 }}>开启后，写分镜/图生图提示词时会把参考图提交给大模型；请确认所用模型确实支持视觉输入。</p>
      <br />
      <button className="primary" onClick={save}>保存配置</button>

      <h3 style={{ marginTop: 24 }}>技能库<span className="muted">（全局 · 所有项目共用）</span></h3>
      <SkillsTab />
      <h3>工作流库<span className="muted">（全局 · 所有项目共用）</span></h3>
      <WorkflowsTab />
    </div>
  );
}