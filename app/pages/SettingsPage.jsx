'use client';
import { useCallback, useEffect, useState } from 'react';
import { Card, CardBody, Button, Input, Checkbox, RadioGroup, Radio, Select, SelectItem, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';
import { HW_PRESETS, HW_DEFAULT_FREE, hardwareMode, isPresetWorkflows, comfyBaseUrl, RUNNINGHUB_TIERS } from '../../lib/shared/index.js';
import { selectKeys, pickKey } from './shared';
import SkillsTab from './SkillsTab';
import WorkflowsTab from './WorkflowsTab';

// ============ 设置 ============
export default function SettingsPage({ onBack }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [savedCfg, setSavedCfg] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState('');
  const [llmTest, setLlmTest] = useState('');
  const [comfyInfo, setComfyInfo] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [agents, setAgents] = useState([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsErr, setAgentsErr] = useState('');
  const [agentTest, setAgentTest] = useState('');
  const [mcpServer, setMcpServer] = useState(null);
  // 读取配置失败不能只弹一次 toast 就把用户留在「配置加载中…」：cfg 一直是 null，
  // 页面永远不会渲染出「返回」按钮，用户既看不到原因、也退不出去（只能刷浏览器）。
  const loadConfig = useCallback(() => {
    setLoadErr('');
    api.get('/api/config')
      .then((c) => { setCfg(c); setSavedCfg(c); detectComfy(c.comfyui); })
      .catch((e) => setLoadErr(e.message || '未知错误'));
    api.get('/api/workflows').then(setWorkflows).catch(() => {});
  }, []);
  useEffect(() => { loadConfig(); }, [loadConfig]);
  const loadAgents = useCallback((force = false) => {
    setAgentsLoading(true);
    setAgentsErr('');
    api.get('/api/agents' + (force ? '?force=1' : ''))
      .then((r) => { setAgents(r.agents || []); setMcpServer(r.mcpServer || null); })
      .catch((e) => setAgentsErr(e.message || '检测失败'))
      .finally(() => setAgentsLoading(false));
  }, []);
  useEffect(() => { loadAgents(false); }, [loadAgents]);
  async function detectComfy(comfyui) {
    try { setComfyInfo(await api.post('/api/comfyui/test', { comfyui })); } catch { setComfyInfo({ ok: false, error: '连接失败' }); }
  }
  async function save() {
    setSaving(true);
    try {
      const s = await api.put('/api/config', cfg);
      setCfg(s); setSavedCfg(s);
      toast.success('已保存');
      return true;
    } catch (e) { toast.error(e.message); return false; }
    finally { setSaving(false); }
  }
  // 返回前若有未保存的修改，先提示保存；「放弃修改并返回」是必须有的一条出口，
  // 否则用户改错了只能点「取消」留在页面，退不出去。放弃会丢改动，所以再确认一次。
  async function handleBack() {
    if (cfg !== savedCfg) {
      const r = await toast.confirm('配置有未保存的修改，保存后再返回？', {
        confirmLabel: '保存并返回',
        extraLabel: '放弃修改并返回',
        extraValue: 'discard',
        extraDanger: true,
        cancelLabel: '取消',
      });
      if (r === 'discard') {
        const sure = await toast.confirm('放弃未保存的修改并返回？修改将丢失。', {
          danger: true,
          confirmLabel: '放弃并返回',
          cancelLabel: '继续编辑',
        });
        if (sure === true) onBack();
        return;
      }
      if (r !== true) return;
      const saved = await save();
      if (!saved) return;
    }
    onBack();
  }
  async function testComfy() {
    try { const r = await api.post('/api/comfyui/test', { comfyui: cfg.comfyui }); setComfyInfo(r); setTest(r.ok ? ('连接成功 · ' + r.system + ' · ' + r.device) : ('连接失败：' + r.error)); } catch (e) { setTest('失败：' + e.message); }
  }
  async function testLlm() {
    setLlmTest('测试中…');
    try { const r = await api.post('/api/llm/test', { llm: cfg.llm }); setLlmTest(r.ok ? ('连接成功 · ' + r.model) : ('连接失败：' + r.error)); } catch (e) { setLlmTest('失败：' + e.message); }
  }
  if (!cfg) {
    return (
      <Card>
        <CardBody className="items-center gap-3 py-10">
          {loadErr ? (
            <>
              <span className="muted">配置加载失败：{loadErr}</span>
              <div className="row" style={{ gap: 8 }}>
                <Button size="sm" color="primary" onPress={loadConfig}>重试</Button>
                <Button size="sm" variant="flat" onPress={onBack}>返回</Button>
              </div>
            </>
          ) : (
            <div className="flex-row items-center justify-center gap-2.5">
              <Spinner size="sm" />
              <span className="muted">配置加载中…</span>
            </div>
          )}
        </CardBody>
      </Card>
    );
  }
  const hwMode = hardwareMode(cfg);
  const isRunningHub = (cfg.comfyui.provider || 'native') === 'runninghub';
  const agentCfg = cfg.agent || { runtime: 'openclaude', extraPath: '', custom: {} };
  const agentRuntime = agentCfg.runtime || 'openclaude';
  const isExternalAgent = agentRuntime !== 'openclaude';
  const externalAgents = agents.filter((a) => a.id !== 'openclaude');
  const selectedAgent = externalAgents.find((a) => a.id === agentRuntime);
  const customCfg = agentCfg.custom || {};
  function setAgent(patch) {
    setCfg({ ...cfg, agent: { ...agentCfg, ...patch } });
  }
  function setAgentCustom(patch) {
    setAgent({ custom: { ...customCfg, ...patch } });
  }
  function switchAgentMode(mode) {
    if (mode === 'openclaude') { setAgent({ runtime: 'openclaude' }); return; }
    const first = externalAgents.find((a) => a.available);
    setAgent({ runtime: first ? first.id : 'custom' });
  }
  async function testAgent() {
    setAgentTest('检测中…');
    try {
      const r = await api.post('/api/agents/test', { agentId: agentRuntime, custom: customCfg });
      setAgentTest(r.ok
        ? ('可用' + (r.version ? ' · ' + r.version : '') + (r.path ? ' · ' + r.path : ''))
        : ('不可用：' + (r.error || '未知错误')));
    } catch (e) {
      setAgentTest('失败：' + e.message);
    }
  }
  function copyMcpConfig() {
    if (!mcpServer) return;
    if (!navigator.clipboard) { toast.error('当前环境不支持剪贴板，请手动复制'); return; }
    const snippet = JSON.stringify({ mcpServers: { ic: { command: mcpServer.command, args: mcpServer.args } } }, null, 2);
    navigator.clipboard.writeText(snippet)
      .then(() => toast.success('MCP 配置已复制'))
      .catch(() => toast.error('复制失败，请手动选择文本'));
  }
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
          <Button size="sm" variant="flat" onPress={handleBack}>返回</Button>
        </div>

        <h3 className="text-base font-semibold" style={{ marginTop: 8 }}>ComfyUI 服务</h3>
        <RadioGroup aria-label="ComfyUI 接口类型" orientation="horizontal" value={cfg.comfyui.provider || 'native'} onValueChange={(v) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, provider: v } })}>
          <Radio value="native">原生ComfyUI接口</Radio>
          <Radio value="runninghub">云端RunningHub接口</Radio>
        </RadioGroup>

        {(cfg.comfyui.provider || 'native') === 'native' && (
          <>
            <p className="muted" style={{ marginTop: 4 }}>
              获取一键部署配套 ComfyUI 工作流：
              <a href="https://pan.quark.cn/s/9748d626c346?pwd=7NcR" target="_blank" rel="noopener noreferrer">https://pan.quark.cn/s/9748d626c346?pwd=7NcR</a>
              ，使用夸克网盘打开链接即可获取。
            </p>
            <div className="row">
              <Input size="sm" className="flex-1" value={cfg.comfyui.baseUrl} onChange={(e) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, baseUrl: e.target.value } })} />
              <Button size="sm" onPress={testComfy}>测试连接</Button>
              {test && <span className="muted">{test}</span>}
            </div>
          </>
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

        <h3 className="text-base font-semibold" style={{ marginTop: 8 }}>Agent 运行时</h3>
        <RadioGroup aria-label="Agent 运行时" orientation="horizontal" value={isExternalAgent ? 'external' : 'openclaude'} onValueChange={switchAgentMode}>
          <Radio value="openclaude">内置 openclaude（默认）</Radio>
          <Radio value="external">外部 Agent（本机 CLI）</Radio>
        </RadioGroup>
        <p className="muted" style={{ marginTop: 4 }}>内置 openclaude 使用下方 LLM 配置；外部 Agent 使用它自己的模型与登录态，并通过本地 MCP 服务调用本项目的领域工具。</p>

        {isExternalAgent && (
          <>
            <div className="row mt-2" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: 'none' }}>选择 Agent</span>
              <Select
                size="sm"
                className="w-72"
                aria-label="外部 Agent"
                placeholder="请选择 Agent"
                selectedKeys={selectKeys(agentRuntime)}
                disallowEmptySelection
                onSelectionChange={(k) => {
                  // 单选下拉再次点已选项时会回传空集合；不能把它当成「切回内置」，
                  // 否则 Agent 运行时会瞬间跳回 openclaude、整个外部 Agent 区块被卸载。
                  const next = pickKey(k);
                  if (next) setAgent({ runtime: next });
                }}
                isDisabled={agentsLoading}
              >
                {externalAgents.map((a) => {
                  const label = a.name + (a.available ? '' : '（未安装）');
                  return (
                    <SelectItem key={a.id} textValue={label} isDisabled={!a.available}>
                      {label}
                    </SelectItem>
                  );
                })}
                <SelectItem key="custom" textValue="自定义 CLI">自定义 CLI</SelectItem>
              </Select>
              <Button size="sm" variant="flat" isLoading={agentsLoading} onPress={() => loadAgents(true)}>重新检测</Button>
              <Button size="sm" onPress={testAgent} isDisabled={agentsLoading}>检测可执行</Button>
            </div>
            {agentsErr && <p className="muted" style={{ marginTop: 4 }}>检测失败：{agentsErr}</p>}
            {externalAgents.some((a) => !a.available) && (
              <p className="muted" style={{ marginTop: 4 }}>
                未安装：{externalAgents.filter((a) => !a.available).map((a, i) => (
                  <span key={a.id}>
                    {i ? '、' : ''}
                    {a.installUrl ? <a href={a.installUrl} target="_blank" rel="noopener noreferrer">{a.name}</a> : a.name}
                  </span>
                ))}
              </p>
            )}
            {selectedAgent && !selectedAgent.available && (
              <p className="muted" style={{ marginTop: 4 }}>
                ❌ 未安装{selectedAgent.bin ? '：' + selectedAgent.bin : ''}
                {selectedAgent.installUrl ? <> · <a href={selectedAgent.installUrl} target="_blank" rel="noopener noreferrer">安装说明</a></> : null}
              </p>
            )}
            {selectedAgent && selectedAgent.available && (
              <p className="muted" style={{ marginTop: 4 }}>✅ 已安装{selectedAgent.version ? ' · ' + selectedAgent.version : ''}{selectedAgent.path ? ' · ' + selectedAgent.path : ''}</p>
            )}
            {selectedAgent?.hint && <p className="muted text-warning" style={{ marginTop: 4 }}>⚠ {selectedAgent.hint}</p>}
            {agentTest && <p className="muted" style={{ marginTop: 4 }}>{agentTest}</p>}

            {agentRuntime === 'custom' && (
              <>
                <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
                  <span style={{ flex: 'none' }}>名称</span>
                  <Input size="sm" className="flex-1" value={customCfg.name || ''} onChange={(e) => setAgentCustom({ name: e.target.value })} placeholder="自定义 CLI" />
                </div>
                <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
                  <span style={{ flex: 'none' }}>可执行文件</span>
                  <Input size="sm" className="flex-1" value={customCfg.bin || ''} onChange={(e) => setAgentCustom({ bin: e.target.value })} placeholder="例如 my-agent 或 /usr/local/bin/my-agent" />
                </div>
                <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
                  <span style={{ flex: 'none' }}>启动参数</span>
                  <Input size="sm" className="flex-1" value={customCfg.args || ''} onChange={(e) => setAgentCustom({ args: e.target.value })} placeholder="例如 --print 或 -p {prompt}；支持 {mcpConfig}" />
                </div>
                <Checkbox size="sm" isSelected={customCfg.promptViaStdin !== false} onValueChange={(v) => setAgentCustom({ promptViaStdin: v })}>
                  通过 stdin 传入 prompt（推荐）
                </Checkbox>
                <p className="muted" style={{ marginTop: 4 }}>自定义 CLI 需要自行接入 MCP。把下方配置加到它的 MCP 设置中；任务运行时本项目会注入 IC_MCP_* 环境变量。</p>
                {mcpServer && (
                  <div className="row mt-2" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Button size="sm" variant="flat" onPress={copyMcpConfig}>复制 MCP 配置</Button>
                    <span className="muted" style={{ wordBreak: 'break-all' }}>{mcpServer.command} {mcpServer.args.join(' ')}</span>
                  </div>
                )}
              </>
            )}

            <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 'none' }}>额外 PATH</span>
              <Input size="sm" className="flex-1" value={agentCfg.extraPath || ''} onChange={(e) => setAgent({ extraPath: e.target.value })} placeholder="可选；多个目录用系统 PATH 分隔符（macOS/Linux 为 :，Windows 为 ;）" />
            </div>
            <p className="muted" style={{ marginTop: 4 }}>
              外部 Agent 使用其自身模型与登录态；本项目通过本地 MCP 服务提供领域工具。外部 Agent 拥有其 CLI 自身权限，请只选择可信 Agent。首次运行请在任务日志确认工具调用。
            </p>
          </>
        )}

        <h3 className="text-base font-semibold" style={{ marginTop: 8 }}>LLM（Agent 大脑，OpenAI 兼容）</h3>
        <p className="muted" style={{ marginTop: 4 }}>
          推荐使用 DeepSeek模型，Base URL 填写 <code>https://api.deepseek.com/v1</code>；<a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">获取 API Key</a>。
        </p>
        <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 'none' }}>Base URL</span>
          <Input size="sm" className="flex-1 min-w-0" placeholder="需 /v1 结尾" value={cfg.llm.baseUrl} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, baseUrl: e.target.value } })} />
        </div>
        <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 'none' }}>模型（推荐：deepseek-v4-flash-vision-exp 模型）</span>
          <Input size="sm" className="flex-1 min-w-0" placeholder="模型" value={cfg.llm.model} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, model: e.target.value } })} />
        </div>
        <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 'none' }}>API Key</span>
          <Input size="sm" className="flex-1" placeholder="API Key" type="password" value={cfg.llm.apiKey} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, apiKey: e.target.value } })} />
        </div>
        <Checkbox size="sm" isSelected={!!cfg.llm.vision} onValueChange={(v) => setCfg({ ...cfg, llm: { ...cfg.llm, vision: v } })}>
          支持图片输入（多模态/视觉模型）
        </Checkbox>
        <p className="muted" style={{ marginTop: 4 }}>开启后，写分镜/图生图提示词时会把参考图提交给大模型；请确认所用模型确实支持视觉输入。</p>
        <div className="row mt-2" style={{ gap: 8, alignItems: 'center' }}>
          <Button size="sm" onPress={testLlm}>测试连接</Button>
          {llmTest && <span className="muted">{llmTest}</span>}
        </div>
      
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

        {!isRunningHub && (
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
          <Button size="sm" color="primary" isLoading={saving} isDisabled={saving} onPress={save}>保存配置</Button>
        </div>

        <h3 className="text-base font-semibold" style={{ marginTop: 24 }}>技能库<span className="muted">（全局 · 所有项目共用）</span></h3>
        <SkillsTab />
        {/* 工作流库：暂隐藏 */}
        {/* <h3 className="text-base font-semibold" style={{ marginTop: 8 }}>工作流库<span className="muted">（全局 · 所有项目共用）</span></h3>
        <WorkflowsTab /> */}
      </CardBody>
    </Card>
  );
}