'use client';
import { useEffect, useState } from 'react';
import { Card, CardBody, Button, Input, Checkbox, RadioGroup, Radio, Select, SelectItem, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import { HW_PRESETS, HW_DEFAULT_FREE, hardwareMode, isPresetWorkflows } from '../../lib/shared/index.js';
import { selectKeys, pickKey } from './shared';
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
  if (!cfg) {
    return (
      <Card>
        <CardBody className="flex-row items-center justify-center gap-2.5 py-10">
          <Spinner size="sm" />
          <span className="muted">配置加载中…</span>
        </CardBody>
      </Card>
    );
  }
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
    <Card>
      <CardBody className="gap-2">
        <div className="row justify-between">
          <h2 className="m-0">设置</h2>
          <Button size="sm" variant="flat" onPress={onBack}>返回</Button>
        </div>

        <h3 className="text-base font-semibold" style={{ marginTop: 8 }}>ComfyUI 服务</h3>
        <div className="row">
          <Input size="sm" className="flex-1" value={cfg.comfyui.baseUrl} onChange={(e) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, baseUrl: e.target.value } })} />
          <Button size="sm" onPress={testComfy}>测试连接</Button>
          {test && <span className="muted">{test}</span>}
        </div>

        <h3 className="text-base font-semibold" style={{ marginTop: 8 }}>LLM（Agent 大脑，OpenAI 兼容）</h3>
        <div className="row">
          <Input size="sm" className="flex-2 min-w-0" placeholder="Base URL（需 /v1 结尾）" value={cfg.llm.baseUrl} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, baseUrl: e.target.value } })} />
          <Input size="sm" className="flex-1 min-w-0" placeholder="模型" value={cfg.llm.model} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, model: e.target.value } })} />
        </div>
        <Input size="sm" className="mt-2" placeholder="API Key" type="password" value={cfg.llm.apiKey} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, apiKey: e.target.value } })} />
        <Checkbox size="sm" isSelected={!!cfg.llm.vision} onValueChange={(v) => setCfg({ ...cfg, llm: { ...cfg.llm, vision: v } })}>
          支持图片输入（多模态/视觉模型）
        </Checkbox>
        <p className="muted" style={{ marginTop: 4 }}>开启后，写分镜/图生图提示词时会把参考图提交给大模型；请确认所用模型确实支持视觉输入。</p>
        <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 'none' }}>提示词改写语言</span>
          <Select size="sm" className="w-64" aria-label="提示词改写语言" selectedKeys={selectKeys(cfg.llm.rewriteLanguage || 'same')} onSelectionChange={(k) => setCfg({ ...cfg, llm: { ...cfg.llm, rewriteLanguage: pickKey(k) } })}>
            <SelectItem key="same">与原提示词一致（推荐）</SelectItem>
            <SelectItem key="zh">中文</SelectItem>
            <SelectItem key="en">英文</SelectItem>
          </Select>
        </div>
        <p className="muted" style={{ marginTop: 4 }}>在分镜里填反馈后选「仅 LLM 改写提示词」时，改写结果用什么语言。默认与原提示词保持一致，避免中英混杂。</p>

        <h3 className="text-base font-semibold" style={{ marginTop: 8 }}>硬件适配</h3>
        <RadioGroup aria-label="硬件适配" orientation="horizontal" value={hwMode} onValueChange={switchMode}>
          <Radio value="nvidia">英伟达（原版工作流）</Radio>
          <Radio value="amd">AMD + GGUF（量化适配版）</Radio>
        </RadioGroup>
        <p className="muted" style={{ marginTop: 4 }}>只影响各阶段实际提交给 ComfyUI 的工作流；默认英伟达原版。AMD 模式下额外启用显存释放与分阶段运行的显存/CK 拦截。</p>

        {hwMode === 'nvidia' && (
          <div className="muted" style={{ margin: '8px 0 0' }}>
            <div className="row" style={{ gap: 8, alignItems: 'center', margin: '4px 0' }}>
              <span style={{ flex: 'none' }}>文生图</span>
              <Select size="sm" className="flex-1 min-w-0" aria-label="文生图工作流" selectedKeys={selectKeys(cfg.workflows.t2i)} onSelectionChange={(k) => setCfg({ ...cfg, workflows: { ...cfg.workflows, t2i: pickKey(k) } })}>
                {workflows.filter((w) => w.kind === 't2i' && w.spec?.hw === 'nvidia').map((w) => (
                  <SelectItem key={w.spec.id}>{w.name}</SelectItem>
                ))}
              </Select>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'center', margin: '4px 0' }}>
              <span style={{ flex: 'none' }}>图生图</span>
              <Select size="sm" className="flex-1 min-w-0" aria-label="图生图工作流" selectedKeys={selectKeys(cfg.workflows.i2i)} onSelectionChange={(k) => setCfg({ ...cfg, workflows: { ...cfg.workflows, i2i: pickKey(k) } })}>
                {workflows.filter((w) => w.kind === 'i2i' && w.spec?.hw === 'nvidia').map((w) => (
                  <SelectItem key={w.spec.id}>{w.name}</SelectItem>
                ))}
              </Select>
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
            <h3 className="text-danger text-lg font-semibold" style={{ marginTop: 8 }}>生成维护</h3>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span>每 N 个生成后释放 ComfyUI 显存</span>
              <Input size="sm" className="w-16" type="number" min={0} max={20} value={String(cfg.generation.freeAfterEvery ?? 0)} onChange={(e) => setCfg({ ...cfg, generation: { ...cfg.generation, freeAfterEvery: Math.max(0, Math.min(20, Math.round(Number(e.target.value) || 0))) } })} />
              <span className="muted">个生成任务（0 = 关闭）</span>
            </div>
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
        <div className="mt-2">
          <Button size="sm" color="primary" onPress={save}>保存配置</Button>
        </div>

        <h3 className="text-base font-semibold" style={{ marginTop: 24 }}>技能库<span className="muted">（全局 · 所有项目共用）</span></h3>
        <SkillsTab />
        <h3 className="text-base font-semibold" style={{ marginTop: 8 }}>工作流库<span className="muted">（全局 · 所有项目共用）</span></h3>
        <WorkflowsTab />
      </CardBody>
    </Card>
  );
}