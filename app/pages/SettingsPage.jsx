'use client';
import { useEffect, useState } from 'react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import { HW_PRESETS, HW_DEFAULT_FREE, hardwareMode, isPresetWorkflows } from '../../lib/shared/index.js';
import SkillsTab from './SkillsTab';
import WorkflowsTab from './WorkflowsTab';

// ============ 设置 ============
export default function SettingsPage({ onBack }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [test, setTest] = useState('');
  const [comfyInfo, setComfyInfo] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  useEffect(() => {
    api.get('/api/config').then((c) => { setCfg(c); detectComfy(c.comfyui.baseUrl); }).catch((e) => toast.error(e.message));
    api.get('/api/workflows').then(setWorkflows).catch(() => {});
  }, []);
  async function detectComfy(baseUrl) {
    try { setComfyInfo(await api.post('/api/comfyui/test', { baseUrl })); } catch { setComfyInfo({ ok: false, error: '连接失败' }); }
  }
  async function save() {
    try { setCfg(await api.put('/api/config', cfg)); toast.success('已保存'); } catch (e) { toast.error(e.message); }
  }
  async function testComfy() {
    try { const r = await api.post('/api/comfyui/test', { baseUrl: cfg.comfyui.baseUrl }); setComfyInfo(r); setTest(r.ok ? ('连接成功 · ' + r.system + ' · ' + r.device) : ('连接失败：' + r.error)); } catch (e) { setTest('失败：' + e.message); }
  }
  if (!cfg) return <div className="muted">加载中…</div>;
  const hwMode = hardwareMode(cfg);
  // 切换硬件模式：工作流列表与「生成维护」默认值立即跟着变，无需先保存；
  // 用户手改过的 workflows / freeAfterEvery（不等于任一模式预设/默认值）保持不动。
  function switchMode(mode) {
    const free = cfg.generation.freeAfterEvery;
    const workflows = isPresetWorkflows(cfg.workflows) ? { ...HW_PRESETS[mode] } : cfg.workflows;
    setCfg({
      ...cfg,
      hardware: { ...cfg.hardware, mode },
      workflows,
      generation: { ...cfg.generation, freeAfterEvery: free == null || Number(free) === HW_DEFAULT_FREE[hwMode] ? HW_DEFAULT_FREE[mode] : free },
    });
  }
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

      <h3 style={{ marginTop: 8 }}>硬件适配</h3>
      <div className="row" style={{ gap: 24 }}>
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input type="radio" name="hwm" checked={hwMode === 'nvidia'} onChange={() => switchMode('nvidia')} />
          <span>英伟达（原版工作流）</span>
        </label>
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input type="radio" name="hwm" checked={hwMode === 'amd'} onChange={() => switchMode('amd')} />
          <span>AMD + GGUF（量化适配版）</span>
        </label>
      </div>
      <p className="muted" style={{ marginTop: 4 }}>只影响各阶段实际提交给 ComfyUI 的工作流；默认英伟达原版。AMD 模式下额外启用显存释放与分阶段运行的显存/CK 拦截。</p>
      {hwMode === 'nvidia' && (
        <div className="muted" style={{ margin: '8px 0 0' }}>
          <div className="row" style={{ gap: 8, alignItems: 'center', margin: '4px 0' }}>
            <span style={{ flex: 'none' }}>文生图</span>
            <select style={{ flex: 1 }} value={cfg.workflows.t2i} onChange={(e) => setCfg({ ...cfg, workflows: { ...cfg.workflows, t2i: e.target.value } })}>
              {workflows.filter((w) => w.kind === 't2i' && w.spec?.hw === 'nvidia').map((w) => (
                <option key={w.spec.id} value={w.spec.id}>{w.name}</option>
              ))}
            </select>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center', margin: '4px 0' }}>
            <span style={{ flex: 'none' }}>图生图</span>
            <select style={{ flex: 1 }} value={cfg.workflows.i2i} onChange={(e) => setCfg({ ...cfg, workflows: { ...cfg.workflows, i2i: e.target.value } })}>
              {workflows.filter((w) => w.kind === 'i2i' && w.spec?.hw === 'nvidia').map((w) => (
                <option key={w.spec.id} value={w.spec.id}>{w.name}</option>
              ))}
            </select>
          </div>
          <div style={{ margin: '4px 0' }}>分镜视频：{cfg.workflows.r2v}</div>
          <div style={{ margin: '4px 0' }}>音色设计：{cfg.workflows.tts}</div>
        </div>
      )}
      {hwMode === 'amd' && (
        <ul className="muted" style={{ margin: '4px 0 0', paddingLeft: 20 }}>
          <li>文生图：{cfg.workflows.t2i}</li>
          <li>图生图：{cfg.workflows.i2i}</li>
          <li>分镜视频：{cfg.workflows.r2v}</li>
          <li>音色设计：{cfg.workflows.tts}</li>
        </ul>
      )}

      {hwMode === 'amd' && (
        <>
          <h3 style={{ marginTop: 8, color: '#c0392b', fontSize: 22 }}>生成维护</h3>
          <label className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span>每 N 个生成后释放 ComfyUI 显存</span>
            <input style={{ width: 64 }} type="number" min={0} max={20} value={cfg.generation.freeAfterEvery ?? 0} onChange={(e) => setCfg({ ...cfg, generation: { ...cfg.generation, freeAfterEvery: Math.max(0, Math.min(20, Math.round(Number(e.target.value) || 0))) } })} />
            <span className="muted">个生成任务（0 = 关闭）</span>
          </label>
          <p className="muted" style={{ marginTop: 4 }}>
            利：AMD 显卡 + Dynamic VRAM 下，任意连续生成（文生图/图生图/换装/音色/视频）都会让显存状态累积、速度逐步变慢；定期释放可保持稳定。
            弊：每次释放后下一个生成需重新加载模型，多花 1~3 分钟；次数设得太小会频繁重载。
          </p>
          {comfyInfo && comfyInfo.ok === false && <p className="muted" style={{ marginTop: 4 }}>⚠ 当前 ComfyUI 连接失败，无法判断 Dynamic VRAM 状态，建议点「测试连接」确认。</p>}
          {comfyInfo && comfyInfo.ok && !comfyInfo.dynamicVram && (cfg.generation.freeAfterEvery ?? 0) > 0 && (
            <p className="muted" style={{ marginTop: 4 }}>⚠ 检测到当前 ComfyUI 未启用 Dynamic VRAM（--disable-dynamic-vram），连续生成不会产生该退化，建议关闭此功能（把 N 设为 0）。</p>
          )}
        </>
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