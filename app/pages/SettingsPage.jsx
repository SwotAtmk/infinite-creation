'use client';
import { useEffect, useState } from 'react';
import { Card, CardBody, Button, Input, Checkbox, RadioGroup, Radio, Select, SelectItem, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import { HW_PRESETS, HW_DEFAULT_FREE, hardwareMode, isPresetWorkflows, comfyBaseUrl, RUNNINGHUB_TIERS } from '../../lib/shared/index.js';
import { selectKeys, pickKey } from './shared';
import ModelPicker from './ModelPicker';
import SkillsTab from './SkillsTab';
import WorkflowsTab from './WorkflowsTab';

// ============ 设置 ============
export default function SettingsPage({ onBack }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [test, setTest] = useState('');
  const [llmTest, setLlmTest] = useState('');
  const [comfyInfo, setComfyInfo] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  useEffect(() => {
    api.get('/api/config').then((c) => { setCfg(c); detectComfy(c.comfyui); }).catch((e) => toast.error(e.message));
    api.get('/api/workflows').then(setWorkflows).catch(() => {});
  }, []);
  async function detectComfy(comfyui) {
    try { setComfyInfo(await api.post('/api/comfyui/test', { comfyui })); } catch { setComfyInfo({ ok: false, error: '连接失败' }); }
  }
  async function save() {
    try { setCfg(await api.put('/api/config', cfg)); toast.success('已保存'); } catch (e) { toast.error(e.message); }
  }
  async function testComfy() {
    try { const r = await api.post('/api/comfyui/test', { comfyui: cfg.comfyui, mediaApi: cfg.mediaApi }); setComfyInfo(r); setTest(r.ok ? ('连接成功 · ' + r.system + ' · ' + r.device) : ('连接失败：' + r.error)); } catch (e) { setTest('失败：' + e.message); }
  }
  // 更新 mediaApi 里某一组（生图/视频/配音）配置，层层展开保持不可变；老配置可能没有 mediaApi，兜底为空对象
  function setMedia(group, patch) {
    setCfg({ ...cfg, mediaApi: { ...(cfg.mediaApi || {}), [group]: { ...(cfg.mediaApi?.[group] || {}), ...patch } } });
  }
  async function testLlm() {
    setLlmTest('测试中…');
    try { const r = await api.post('/api/llm/test', { llm: cfg.llm }); setLlmTest(r.ok ? ('连接成功 · ' + r.model) : ('连接失败：' + r.error)); } catch (e) { setLlmTest('失败：' + e.message); }
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
  const isNative = (cfg.comfyui.provider || 'native') === 'native';
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

        <h3 className="text-base font-semibold" style={{ marginTop: 8 }}>渲染服务 / 媒体生成后端</h3>
        <RadioGroup aria-label="渲染服务类型" orientation="horizontal" value={cfg.comfyui.provider || 'native'} onValueChange={(v) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, provider: v } })}>
          <Radio value="native">原生ComfyUI接口</Radio>
          <Radio value="runninghub">云端RunningHub接口</Radio>
          <Radio value="api">云端商业API</Radio>
        </RadioGroup>

        {(cfg.comfyui.provider || 'native') === 'native' && (
          <div className="row">
            <Input size="sm" className="flex-1" value={cfg.comfyui.baseUrl} onChange={(e) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, baseUrl: e.target.value } })} />
            <Button size="sm" onPress={testComfy}>测试连接</Button>
            {test && <span className="muted">{test}</span>}
          </div>
        )}

        {(cfg.comfyui.provider || 'native') === 'runninghub' && (
          <>
            <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 'none' }}>Api-key</span>
              <Input size="sm" type="password" className="flex-1" placeholder="请输入 RunningHub Api-key" value={cfg.comfyui.apiKey || ''} onChange={(e) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, apiKey: e.target.value } })} />
              <Button size="sm" onPress={() => window.open('https://www.runninghub.cn/call-api/bill-task?tab=keys&type=consumer&inviteCode=6to0etcb', '_blank', 'noopener,noreferrer')}>查询Api-key</Button>
            </div>
            <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 'none' }}>版本</span>
              <Select size="sm" className="w-64" aria-label="RunningHub 版本" selectedKeys={selectKeys(cfg.comfyui.tier || 'standard')} onSelectionChange={(k) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, tier: pickKey(k) } })}>
                {RUNNINGHUB_TIERS.map((t) => <SelectItem key={t.id}>{t.label}</SelectItem>)}
              </Select>
            </div>
            <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 'none' }}>任务并发数量【bate】</span>
              <Input size="sm" className="w-24" type="number" min={1} max={20} value={String(cfg.generation.runninghubConcurrency ?? 1)} onChange={(e) => setCfg({ ...cfg, generation: { ...cfg.generation, runninghubConcurrency: Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))) } })} />
              <span className="muted">并发任务数（默认 1）</span>
            </div>
            <p className="muted" style={{ marginTop: 4 }}>云端 RunningHub 支持并发执行，可同时提交多个生成任务以提高效率；并发过高可能触发云端限流或排队。</p>
            <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
              <Button size="sm" onPress={testComfy}>测试连接</Button>
              {test && <span className="muted">{test}</span>}
            </div>
            <p className="muted" style={{ marginTop: 4 }}>最终服务 URL：{comfyBaseUrl(cfg)}</p>
          </>
        )}

        {(cfg.comfyui.provider || 'native') === 'api' && (
          <>
            <p className="muted" style={{ marginTop: 4 }}>不用自己部署 ComfyUI，直接调云端商业 API 生成图片、视频和配音。三段各自填好就能跑完整流程，先填一段也能先用一段。</p>

            <h4 className="text-sm font-semibold" style={{ marginTop: 8 }}>生图 · OpenAI 兼容</h4>
            <Input size="sm" className="mt-2" placeholder="API Key" type="password" value={cfg.mediaApi?.image?.apiKey || ''} onChange={(e) => setMedia('image', { apiKey: e.target.value })} />
            <ModelPicker
              group="image"
              baseUrl={cfg.mediaApi?.image?.baseUrl}
              apiKey={cfg.mediaApi?.image?.apiKey}
              value={cfg.mediaApi?.image?.model || ''}
              onChange={(v) => setMedia('image', { model: v })}
              placeholder="gpt-image-2.5"
              hint="默认 gpt-image-2.5"
              className="row mt-2"
            />
            <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 'none' }}>Base URL</span>
              <Input size="sm" className="flex-1 min-w-0" value={cfg.mediaApi?.image?.baseUrl || ''} onChange={(e) => setMedia('image', { baseUrl: e.target.value })} />
            </div>
            <p className="muted" style={{ marginTop: 4 }}>走的是 OpenAI 兼容的中转站，一个 API Key 就够（卖家给你的那个）。文生图、图生图都从这里走。</p>

            <h4 className="text-sm font-semibold" style={{ marginTop: 8 }}>视频 · OpenAI 兼容</h4>
            <Input size="sm" className="mt-2" placeholder="API Key" type="password" value={cfg.mediaApi?.video?.apiKey || ''} onChange={(e) => setMedia('video', { apiKey: e.target.value })} />
            <ModelPicker
              group="video"
              baseUrl={cfg.mediaApi?.video?.baseUrl}
              apiKey={cfg.mediaApi?.video?.apiKey}
              value={cfg.mediaApi?.video?.model || ''}
              onChange={(v) => setMedia('video', { model: v })}
              placeholder="grok-imagine-video-1.5-fast"
              hint="默认 grok-imagine-video-1.5-fast"
              className="row mt-2"
            />
            <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 'none' }}>Base URL</span>
              <Input size="sm" className="flex-1 min-w-0" value={cfg.mediaApi?.video?.baseUrl || ''} onChange={(e) => setMedia('video', { baseUrl: e.target.value })} />
            </div>
            <p className="muted" style={{ marginTop: 4 }}>跟生图是同一个中转站，API Key 一般也一样（卖家给你哪个就填哪个）。走的是 OpenAI 的视频接口。</p>

            <h4 className="text-sm font-semibold" style={{ marginTop: 8 }}>配音 · 小米 MiMo</h4>
            <Input size="sm" className="mt-2" placeholder="API Key" type="password" value={cfg.mediaApi?.tts?.apiKey || ''} onChange={(e) => setMedia('tts', { apiKey: e.target.value })} />
            <ModelPicker
              group="tts"
              baseUrl={cfg.mediaApi?.tts?.baseUrl}
              apiKey={cfg.mediaApi?.tts?.apiKey}
              value={cfg.mediaApi?.tts?.model || ''}
              onChange={(v) => setMedia('tts', { model: v })}
              placeholder="mimo-v2.5-tts-voicedesign"
              hint="默认 mimo-v2.5-tts-voicedesign"
              className="row mt-2"
            />
            <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 'none' }}>Base URL</span>
              <Input size="sm" className="flex-1 min-w-0" value={cfg.mediaApi?.tts?.baseUrl || ''} onChange={(e) => setMedia('tts', { baseUrl: e.target.value })} />
            </div>
            <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 'none' }}>固定音色 ID</span>
              <Input size="sm" className="w-64" placeholder="留空即可" value={cfg.mediaApi?.tts?.voiceId || ''} onChange={(e) => setMedia('tts', { voiceId: e.target.value })} />
            </div>
            <p className="muted" style={{ marginTop: 4 }}>这个框建议留空：留空 = 每个角色按自己的音色描述自动生成（voicedesign 模型就是靠文字描述造音色的，推荐这么用）；填了 = 所有角色都用这一个固定音色，角色的音色描述就不管用了。</p>
            <p className="muted" style={{ marginTop: 4 }}>配音的 Key 是另一家的：去小米 MiMo 开放平台买「令牌套餐」，在套餐里生成 Key（tp- 开头）。跟上面生图/视频的中转站 Key 不通用，要单独填。这把 Key 同时也能给下面的「编剧大模型」用——同一个网址、同一把 Key，模型名换成 mimo-v2.6-pro 即可。</p>

            <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
              <Button size="sm" onPress={testComfy}>测试连接</Button>
              {test && <span className="muted">{test}</span>}
            </div>
            <p className="muted" style={{ marginTop: 4 }}>会挨个试一下已填的 key 能不能连上，填完建议先测一遍再保存。</p>
          </>
        )}

        <h3 className="text-base font-semibold" style={{ marginTop: 8 }}>LLM（Agent 大脑，OpenAI 兼容）</h3>
        <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 'none' }}>Base URL</span>
          <Input size="sm" className="flex-1 min-w-0" placeholder="需 /v1 结尾" value={cfg.llm.baseUrl} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, baseUrl: e.target.value } })} />
        </div>
        <ModelPicker
          group="llm"
          label="模型"
          baseUrl={cfg.llm.baseUrl}
          apiKey={cfg.llm.apiKey}
          value={cfg.llm.model || ''}
          onChange={(v) => setCfg({ ...cfg, llm: { ...cfg.llm, model: v } })}
          placeholder="模型"
          className="row mt-2"
          controlClass="flex-1 min-w-0"
        />
        <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 'none' }}>API Key</span>
          <Input size="sm" className="flex-1" placeholder="API Key" type="password" value={cfg.llm.apiKey} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, apiKey: e.target.value } })} />
        </div>
        <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
          <Button size="sm" onPress={testLlm}>测试连接</Button>
          {llmTest && <span className="muted">{llmTest}</span>}
        </div>
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
        <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 'none' }}>改写最大输出（token）</span>
          <Input size="sm" className="w-28" type="number" min={256} max={32768} value={String(cfg.llm.rewriteMaxTokens ?? 4000)} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, rewriteMaxTokens: Math.max(256, Math.min(32768, Math.round(Number(e.target.value) || 0))) } })} />
          <span className="muted">默认 4000</span>
        </div>
        <p className="muted" style={{ marginTop: 4, lineHeight: 1.7 }}>
          <b>作用：</b>分镜里填反馈后选「仅 LLM 改写提示词」时，允许大模型输出的最大长度（token）。
          <br />
          <b>为什么要设：</b>若本机模型是「思考型」（响应里带 reasoning_content），它会先思考再写正文，而<b>思考与正文共用这一份预算</b>；预算不足时正文会在开头就被截断——表现为改写只剩一两句、<code>__MINIMAX_H3_REF_N__</code> 参考占位符丢失，随后视频画面对不上。之所以「时好时坏」，是因为每次思考长度都不同。
          <br />
          <b>建议：</b>默认 4000 约可容纳「思考 ~2000 字 + 正文 ~500 字」。调大更不容易被截断，但更慢、更吃显存；调小会频繁触发「输出被截断」而重试甚至失败（范围 256–32768）。
          <br />
          <b>何时调：</b>任务报「LLM 改写提示词不可用（LLM 输出被截断（达到长度上限））」时，优先调大此值。
        </p>

        {isNative && (
          <>
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