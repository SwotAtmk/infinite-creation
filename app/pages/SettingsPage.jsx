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
  const [comfyInfo, setComfyInfo] = useState(null);
  useEffect(() => {
    api.get('/api/config').then((c) => { setCfg(c); detectComfy(c.comfyui.baseUrl); }).catch((e) => toast.error(e.message));
  }, []);
  async function detectComfy(baseUrl) {
    try { setComfyInfo(await api.post('/api/comfyui/test', { baseUrl })); } catch { setComfyInfo({ ok: false, error: '连接失败' }); }
  }
  async function save() {
    try { await api.put('/api/config', cfg); toast.success('已保存'); } catch (e) { toast.error(e.message); }
  }
  async function testComfy() {
    try { const r = await api.post('/api/comfyui/test', { baseUrl: cfg.comfyui.baseUrl }); setComfyInfo(r); setTest(r.ok ? ('连接成功 · ' + r.system + ' · ' + r.device) : ('连接失败：' + r.error)); } catch (e) { setTest('失败：' + e.message); }
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

      <h3 style={{ marginTop: 8 }}>生成维护</h3>
      <label className="row" style={{ gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={(cfg.generation.videoFreeAfterEvery || 0) > 0} onChange={(e) => setCfg({ ...cfg, generation: { ...cfg.generation, videoFreeAfterEvery: e.target.checked ? Math.max(1, cfg.generation.videoFreeAfterEvery || 3) : 0 } })} />
        <span>每 N 个视频后释放 ComfyUI 显存</span>
        <input style={{ width: 64 }} type="number" min={1} max={20} disabled={(cfg.generation.videoFreeAfterEvery || 0) <= 0} value={(cfg.generation.videoFreeAfterEvery || 0) > 0 ? cfg.generation.videoFreeAfterEvery : ''} onChange={(e) => setCfg({ ...cfg, generation: { ...cfg.generation, videoFreeAfterEvery: Math.max(1, Math.min(20, Number(e.target.value) || 1)) } })} />
        <span className="muted">个视频</span>
      </label>
      <p className="muted" style={{ marginTop: 4 }}>
        利：AMD 显卡 + Dynamic VRAM 下连续生成多个视频后，显存状态累积会让速度逐步变慢；定期释放可保持稳定。
        弊：每次释放后下一个视频需重新加载模型，多花 1~3 分钟；次数设得太小会频繁重载。
        （0 = 关闭）
      </p>
      {comfyInfo && comfyInfo.ok === false && <p className="muted" style={{ marginTop: 4 }}>⚠ 当前 ComfyUI 连接失败，无法判断 Dynamic VRAM 状态，建议点「测试连接」确认。</p>}
      {comfyInfo && comfyInfo.ok && !comfyInfo.dynamicVram && (cfg.generation.videoFreeAfterEvery || 0) > 0 && (
        <p className="muted" style={{ marginTop: 4 }}>⚠ 检测到当前 ComfyUI 未启用 Dynamic VRAM（--disable-dynamic-vram），连续生成不会产生该退化，建议关闭此功能（把 N 设为 0）。</p>
      )}
      <br />
      <button className="primary" onClick={save}>保存配置</button>

      <h3 style={{ marginTop: 24 }}>技能库<span className="muted">（全局 · 所有项目共用）</span></h3>
      <SkillsTab />
      <h3>工作流库<span className="muted">（全局 · 所有项目共用）</span></h3>
      <WorkflowsTab />
    </div>
  );
}