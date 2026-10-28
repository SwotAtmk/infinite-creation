import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Cloud,
  Cpu,
  Film,
  KeyRound,
  Lock,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  Wand2,
  XCircle,
} from 'lucide-react';
import { api } from '../lib/api.js';
import {
  HW_DEFAULT_FREE,
  HW_PRESETS,
  RUNNINGHUB_TIERS,
  comfyBaseUrl,
  hardwareMode,
  isPresetWorkflows,
} from '../lib/shared.js';
import { COMFY_PROVIDERS } from '@shared';
import { Badge, Button, EmptyState, Field, Input, Segmented, Select, Spinner, Switch } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';
import SkillsPanel from '../components/SkillsPanel.jsx';
import UsersPanel from '../components/UsersPanel.jsx';
import { useToast } from '../components/toast.jsx';

const PROVIDER_OPTIONS = COMFY_PROVIDERS.map((p) => ({ value: p.id, label: p.label }));
const TIER_OPTIONS = RUNNINGHUB_TIERS.map((t) => ({ value: t.id, label: t.label }));
const REWRITE_LANG_OPTIONS = [
  { value: 'same', label: '与原提示词一致（推荐）' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
];

export default function SettingsPage({ onBack, publicMode = false }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [savedCfg, setSavedCfg] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState('');
  const [llmTest, setLlmTest] = useState('');
  const [comfyInfo, setComfyInfo] = useState(null);
  const [workflows, setWorkflows] = useState([]);

  const loadConfig = useCallback(() => {
    setLoadErr('');
    api
      .get('/api/config')
      .then((c) => {
        setCfg(c);
        setSavedCfg(c);
        detectComfy(c.comfyui);
      })
      .catch((e) => setLoadErr(e.message || '未知错误'));
    api.get('/api/workflows').then(setWorkflows).catch(() => {});
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  async function detectComfy(comfyui) {
    try {
      setComfyInfo(await api.post('/api/comfyui/test', { comfyui }));
    } catch {
      setComfyInfo({ ok: false, error: '连接失败' });
    }
  }

  // —— 渲染队列（RunningHub 多用户调度）——
  // 所有值随配置保存；调度器每轮重新读 config.json，改完立即生效，不需要重启。
  const queue = cfg?.generation?.queue || {};
  const setQueue = (patch) =>
    setCfg((c) => ({ ...c, generation: { ...c.generation, queue: { ...(c.generation.queue || {}), ...patch } } }));
  const setPoolMin = (pool, value) =>
    setQueue({ pools: { ...(queue.pools || {}), [pool]: { ...((queue.pools || {})[pool] || {}), min: value } } });
  const clampInt = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };

  async function save() {
    setSaving(true);
    try {
      const s = await api.put('/api/config', cfg);
      setCfg(s);
      setSavedCfg(s);
      toast.success('配置已保存');
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function canLeave() {
    if (cfg !== savedCfg) {
      const ok = await toast.confirm('配置有未保存的修改，保存后再返回？', { confirmLabel: '保存并返回', cancelLabel: '取消' });
      if (!ok) return false;
      const saved = await save();
      if (!saved) return false;
    }
    return true;
  }

  async function handleBack() {
    if (!(await canLeave())) return;
    onBack();
  }

  async function goAdmin() {
    if (!(await canLeave())) return;
    window.location.assign('/admin');
  }

  async function testComfy() {
    try {
      const r = await api.post('/api/comfyui/test', { comfyui: cfg.comfyui });
      setComfyInfo(r);
      setTest(r.ok ? '连接成功 · ' + r.system + ' · ' + r.device : '连接失败：' + r.error);
    } catch (e) {
      setTest('失败：' + e.message);
    }
  }

  async function testLlm() {
    setLlmTest('测试中…');
    try {
      const r = await api.post('/api/llm/test', { llm: cfg.llm });
      setLlmTest(r.ok ? '连接成功 · ' + r.model : '连接失败：' + r.error);
    } catch (e) {
      setLlmTest('失败：' + e.message);
    }
  }

  if (!cfg) {
    return (
      <div className="panel mx-auto flex w-full max-w-[520px] flex-col items-center gap-3 px-6 py-12">
        {loadErr ? (
          <>
            <EmptyState icon={Settings2} title="配置加载失败" description={loadErr} />
            <div className="flex gap-2">
              <Button variant="primary" size="md" onClick={loadConfig}>
                重试
              </Button>
              <Button variant="secondary" size="md" onClick={onBack}>
                返回
              </Button>
            </div>
          </>
        ) : (
          <>
            <Spinner size={18} />
            <span className="text-[12px] text-[var(--fg-3)]">配置加载中…</span>
          </>
        )}
      </div>
    );
  }

  const hwMode = hardwareMode(cfg);
  const isRunningHub = (cfg.comfyui.provider || 'native') === 'runninghub';
  const dirty = cfg !== savedCfg;

  // 对外托管模式：密钥、工作流、硬件适配、技能管理都属于管理员范畴，
  // 前端只展示只读的服务信息，避免把任何密钥或可写配置暴露给外部用户。
  if (publicMode) {
    return (
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5">
        <PageHeader
          eyebrow="Service"
          title="服务信息"
          description="本页面由管理员统一托管；生成服务与密钥均在服务端，不会下发到浏览器。"
          actions={
            <Button variant="ghost" size="md" onClick={onBack}>
              <ArrowLeft size={14} /> 返回
            </Button>
          }
        />
        <Section icon={Cloud} title="生成服务" description="由管理员配置">
          <div className="grid gap-2.5 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3.5 text-[11.5px] sm:grid-cols-2">
            <ReadonlyRow label="执行端" value={isRunningHub ? '云端渲染' : '原生 ComfyUI'} />
            <ReadonlyRow label="云端版本" value={isRunningHub ? cfg.comfyui.tier || 'standard' : '—'} />
            <ReadonlyRow label="LLM 模型" value={cfg.llm.model || '—'} />
            <ReadonlyRow label="视觉输入" value={cfg.llm.vision ? '已开启' : '未开启'} />
            <ReadonlyRow label="视频超时" value={(cfg.generation.videoTimeoutMinutes || '—') + ' 分钟'} />
            <ReadonlyRow label="图片超时" value={(cfg.generation.imageTimeoutMinutes || '—') + ' 分钟'} />
          </div>
        </Section>
        <Section icon={Lock} title="数据与隐私" description="外部接入说明">
          <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
            <li>项目、素材与成片保存在服务端；浏览器端只能访问当前服务暴露的接口。</li>
            <li>上层应用可通过 iframe URL 的 <code className="font-mono text-[var(--fg-2)]">session</code> 参数或 postMessage 传入会话标识，Studio 会透传到服务端请求头。</li>
            <li>会话校验与数据隔离需要在服务端 / 网关层落实，前端透传本身不是安全边界。</li>
          </ul>
        </Section>
      </div>
    );
  }

  function switchMode(mode) {
    const free = cfg.generation.freeAfterEvery;
    const workflowsNext = isPresetWorkflows(cfg.workflows) ? { ...HW_PRESETS[mode] } : cfg.workflows;
    setCfg({
      ...cfg,
      hardware: { ...cfg.hardware, mode },
      workflows: workflowsNext,
      generation: {
        ...cfg.generation,
        freeAfterEvery: free == null || Number(free) === HW_DEFAULT_FREE[hwMode] ? HW_DEFAULT_FREE[mode] : free,
      },
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5">
      <PageHeader
        eyebrow="Settings"
        title="设置"
        description="ComfyUI 服务、Agent 大脑与硬件适配；修改后需要保存才会生效。"
        actions={
          <>
            <Button variant="ghost" size="md" onClick={handleBack}>
              <ArrowLeft size={14} /> 返回
            </Button>
            {!publicMode ? (
              <Button variant="ghost" size="md" onClick={goAdmin}>
                <ShieldCheck size={14} /> 管理后台
              </Button>
            ) : null}
            <Button variant="primary" size="md" loading={saving} onClick={save}>
              <Save size={14} /> 保存配置
            </Button>
          </>
        }
      />

      <Section icon={Server} title="ComfyUI 服务" description="生成图片与视频的执行端">
        <Segmented value={cfg.comfyui.provider || 'native'} onChange={(v) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, provider: v } })} options={PROVIDER_OPTIONS} />
        <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
          当前执行端：<b className="text-[var(--fg-2)]">{isRunningHub ? '云端渲染' : '本地 ComfyUI'}</b>
          {' · '}有效并发 <b className="text-[var(--fg-2)]">{isRunningHub ? Math.max(1, Number(cfg.generation?.runninghubConcurrency) || 1) : 1}</b>
          {isRunningHub
            ? '（由下方「任务并发数量」控制，保存后立即生效）'
            : '（本地 ComfyUI 单队列串行，固定为 1；切到云端后按任务并发数量调度）'}
        </p>

        {!isRunningHub ? (
          <>
            <Field
              label="服务地址"
              hint={
                <span>
                  配套工作流可从{' '}
                  <a href="https://pan.quark.cn/s/9748d626c346?pwd=7NcR" target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                    夸克网盘
                  </a>{' '}
                  获取。
                </span>
              }
            >
              <div className="flex flex-wrap gap-2">
                <Input value={cfg.comfyui.baseUrl} onChange={(e) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, baseUrl: e.target.value } })} className="min-w-[240px] flex-1" />
                <Button variant="secondary" size="md" onClick={testComfy}>
                  测试连接
                </Button>
              </div>
            </Field>
            <TestResult text={test} />
          </>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Api-key" hint="云端渲染执行，无需本地显卡。">
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={cfg.comfyui.apiKey || ''}
                    onChange={(e) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, apiKey: e.target.value } })}
                    placeholder="请输入云端渲染 Api-key"
                    className="flex-1"
                  />
                  <Button
                    variant="secondary"
                    size="icon"
                    title="查询 Api-key"
                    aria-label="查询 Api-key"
                    onClick={() => window.open('https://www.runninghub.cn/call-api/bill-task?tab=keys&type=consumer&inviteCode=6to0etcb', '_blank', 'noopener,noreferrer')}
                  >
                    <KeyRound size={14} />
                  </Button>
                </div>
              </Field>
              <Field label="版本">
                <Select value={cfg.comfyui.tier || 'standard'} onChange={(v) => setCfg({ ...cfg, comfyui: { ...cfg.comfyui, tier: v } })} items={TIER_OPTIONS} />
              </Field>
            </div>
            <Field label="任务并发数量（Beta）" hint="并发过高可能触发云端限流或排队。">
              <Input
                type="number"
                min={1}
                max={20}
                value={String(cfg.generation.runninghubConcurrency ?? 1)}
                onChange={(e) =>
                  setCfg({ ...cfg, generation: { ...cfg.generation, runninghubConcurrency: Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))) } })
                }
                className="w-28"
              />
            </Field>

            <div className="rounded-xl border border-[var(--line)] bg-white/[0.015] p-3.5">
              <p className="m-0 text-[12px] font-medium text-[var(--fg-2)]">多用户排队调度</p>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--fg-4)]">
                全局槽位 = 上面的「任务并发数量」。以下控制槽位如何在用户之间轮转分配，保存后立即生效（无需重启）。
                默认按在线人数动态分配，一人独占时可用满全部槽位，多人时自动收缩、批量提交不会堵死后来者。
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="单用户并发上限" hint="0 = 按在线人数自动（推荐）">
                  <Input
                    type="number"
                    min={0}
                    max={20}
                    value={String(queue.perUserConcurrency ?? 0)}
                    onChange={(e) => setQueue({ perUserConcurrency: clampInt(e.target.value, 0, 20, 0) })}
                    className="w-28"
                  />
                </Field>
                <Field label="每人最多排队" hint="超出直接拒绝，防止队列无限膨胀">
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={String(queue.perUserMaxWaiting ?? 50)}
                    onChange={(e) => setQueue({ perUserMaxWaiting: clampInt(e.target.value, 1, 500, 50) })}
                    className="w-28"
                  />
                </Field>
                <Field label="等待提权（分钟）" hint="排队超过该时长自动优先，防止饿死">
                  <Input
                    type="number"
                    min={0}
                    max={180}
                    value={String(queue.agingMinutes ?? 15)}
                    onChange={(e) => setQueue({ agingMinutes: clampInt(e.target.value, 0, 180, 15) })}
                    className="w-28"
                  />
                </Field>
                <Field label="排队超时（分钟）" hint="等不到槽位就主动放弃">
                  <Input
                    type="number"
                    min={1}
                    max={720}
                    value={String(queue.queueTimeoutMinutes ?? 120)}
                    onChange={(e) => setQueue({ queueTimeoutMinutes: clampInt(e.target.value, 1, 720, 120) })}
                    className="w-28"
                  />
                </Field>
                <Field label="失败自动重试" hint="仅网络/超时类错误会重试">
                  <Input
                    type="number"
                    min={0}
                    max={5}
                    value={String(queue.retryTimes ?? 2)}
                    onChange={(e) => setQueue({ retryTimes: clampInt(e.target.value, 0, 5, 2) })}
                    className="w-28"
                  />
                </Field>
                <Field label="余额不足自动暂停（分钟）" hint="命中配额错误时暂停派发，任务不丢">
                  <Input
                    type="number"
                    min={0}
                    max={120}
                    value={String(queue.pauseOnQuotaErrorMinutes ?? 10)}
                    onChange={(e) => setQueue({ pauseOnQuotaErrorMinutes: clampInt(e.target.value, 0, 120, 10) })}
                    className="w-28"
                  />
                </Field>
                <Field label="图片保底槽位" hint="有积压时优先保留，避免被长视频堵死">
                  <Input
                    type="number"
                    min={0}
                    max={20}
                    value={String(queue.pools?.image?.min ?? 1)}
                    onChange={(e) => setPoolMin('image', clampInt(e.target.value, 0, 20, 1))}
                    className="w-28"
                  />
                </Field>
                <Field label="视频保底槽位">
                  <Input
                    type="number"
                    min={0}
                    max={20}
                    value={String(queue.pools?.video?.min ?? 1)}
                    onChange={(e) => setPoolMin('video', clampInt(e.target.value, 0, 20, 1))}
                    className="w-28"
                  />
                </Field>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="md" onClick={testComfy}>
                测试连接
              </Button>
              <span className="font-mono text-[10.5px] text-[var(--fg-4)]">最终服务 URL：{comfyBaseUrl(cfg)}</span>
            </div>
            <TestResult text={test} />
          </>
        )}
      </Section>

      <Section icon={Sparkles} title="LLM · Agent 大脑" description="OpenAI 兼容接口，负责剧本、分镜与提示词">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Base URL" hint="需以 /v1 结尾。" className="sm:col-span-2">
            <Input value={cfg.llm.baseUrl} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, baseUrl: e.target.value } })} placeholder="https://api.example.com/v1" />
          </Field>
          <Field label="模型">
            <Input value={cfg.llm.model} onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, model: e.target.value } })} placeholder="模型名" />
          </Field>
          <Field label="API Key">
            <Input
              type="password"
              value={cfg.llm.apiKey || ''}
              onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, apiKey: e.target.value } })}
              placeholder="API Key"
            />
          </Field>
        </div>

        <Switch
          checked={!!cfg.llm.vision}
          onChange={(v) => setCfg({ ...cfg, llm: { ...cfg.llm, vision: v } })}
          label="支持图片输入（多模态 / 视觉模型）"
          hint="开启后，写分镜 / 图生图提示词时会把参考图提交给大模型；请确认模型确实支持视觉输入。"
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="md" onClick={testLlm}>
            测试连接
          </Button>
          <TestResult text={llmTest} />
        </div>

        <div className="hairline" />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="提示词改写语言" hint="分镜反馈选择「仅 LLM 改写」时的输出语言。">
            <Select
              value={cfg.llm.rewriteLanguage || 'same'}
              onChange={(v) => setCfg({ ...cfg, llm: { ...cfg.llm, rewriteLanguage: v } })}
              items={REWRITE_LANG_OPTIONS}
            />
          </Field>
          <Field label="改写最大输出（token）" hint="默认 4000；范围 256 - 32768。">
            <Input
              type="number"
              min={256}
              max={32768}
              value={String(cfg.llm.rewriteMaxTokens ?? 4000)}
              onChange={(e) =>
                setCfg({ ...cfg, llm: { ...cfg.llm, rewriteMaxTokens: Math.max(256, Math.min(32768, Math.round(Number(e.target.value) || 0))) } })
              }
            />
          </Field>
        </div>
        <details className="rounded-xl border border-[var(--line)] bg-white/[0.015] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
          <summary className="cursor-pointer text-[var(--fg-3)] hover:text-[var(--fg-2)]">为什么需要设置改写输出上限？</summary>
          <p className="m-0 mt-2">
            思考型模型会先输出 reasoning、再写正文，二者共用这一份预算；预算不足时正文会被截断，表现为改写只剩一两句、参考占位符丢失。
            建议默认 4000；任务报「LLM 输出被截断」时优先调大。
          </p>
        </details>
      </Section>

      <Section icon={Film} title="分镜视频生成" description="每个分镜一次生成几条候选视频；候选越多，渲染耗时和显存占用越高。">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="分镜抽卡数量" hint="默认 1（一个分镜一条视频）；>1 时生成多个候选供勾选最优导出，范围 1-10。">
            <Input
              type="number"
              min={1}
              max={10}
              value={String(cfg.generation?.videosPerShot ?? 1)}
              onChange={(e) =>
                setCfg({ ...cfg, generation: { ...cfg.generation, videosPerShot: Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 1))) } })
              }
            />
          </Field>
        </div>
        <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
          生成多个候选会成倍增加渲染耗时与显存占用，建议 2～3。修改后对新提交的分镜任务生效；已有候选不会被删除。
        </p>
      </Section>

      <Section icon={Users} title="Agent 调度" description="多个章节并行时，限制同时运行的 Agent 会话数；超出的任务会排队等待。">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="同时运行的 Agent 数" hint="默认 4。每个章节占一个槽位（包含渲染等待），建议 2～4。">
            <Input
              type="number"
              min={1}
              max={32}
              value={String(cfg.generation?.agentConcurrency ?? 4)}
              onChange={(e) =>
                setCfg({ ...cfg, generation: { ...cfg.generation, agentConcurrency: Math.max(1, Math.min(32, Math.round(Number(e.target.value) || 4))) } })
              }
            />
          </Field>
          <Field label="Agent 排队超时（分钟）" hint="等待空闲槽位超过该时长自动放弃，避免任务永久排队。">
            <Input
              type="number"
              min={1}
              max={1440}
              value={String(cfg.generation?.agentQueueTimeoutMinutes ?? 120)}
              onChange={(e) =>
                setCfg({ ...cfg, generation: { ...cfg.generation, agentQueueTimeoutMinutes: Math.max(1, Math.min(1440, Math.round(Number(e.target.value) || 120))) } })
              }
            />
          </Field>
        </div>
        <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
          超出的章节会显示「等待 Agent 槽位」，不会占用模型请求，也不会触发模型停滞看门狗。渲染仍由云端渲染队列按并发数控制。
        </p>
      </Section>

      {!isRunningHub ? (
        <Section icon={Cpu} title="硬件适配" description="只影响实际提交给 ComfyUI 的工作流">
          <Segmented
            value={hwMode}
            onChange={switchMode}
            options={[
              { value: 'nvidia', label: '英伟达 · 原版工作流' },
              { value: 'amd', label: 'AMD · GGUF 量化适配' },
            ]}
          />
          <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-3)]">
            默认英伟达原版；AMD 模式额外启用显存释放与分阶段运行的显存 / CK 拦截。
          </p>

          {hwMode === 'nvidia' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="文生图工作流">
                <Select
                  value={cfg.workflows.t2i}
                  onChange={(v) => setCfg({ ...cfg, workflows: { ...cfg.workflows, t2i: v } })}
                  items={workflows.filter((w) => w.kind === 't2i' && w.spec?.hw === 'nvidia').map((w) => ({ value: w.spec.id, label: w.name }))}
                />
              </Field>
              <Field label="图生图工作流">
                <Select
                  value={cfg.workflows.i2i}
                  onChange={(v) => setCfg({ ...cfg, workflows: { ...cfg.workflows, i2i: v } })}
                  items={workflows.filter((w) => w.kind === 'i2i' && w.spec?.hw === 'nvidia').map((w) => ({ value: w.spec.id, label: w.name }))}
                />
              </Field>
              <ReadonlyRow label="分镜视频" value={cfg.workflows.r2v} />
              <ReadonlyRow label="音色设计" value={cfg.workflows.tts} />
              <ReadonlyRow label="背景音乐" value={cfg.workflows.music} />
            </div>
          ) : (
            <div className="grid gap-2 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3 text-[11.5px] sm:grid-cols-2">
              <ReadonlyRow label="文生图" value={cfg.workflows.t2i} />
              <ReadonlyRow label="图生图" value={cfg.workflows.i2i} />
              <ReadonlyRow label="分镜视频" value={cfg.workflows.r2v} />
              <ReadonlyRow label="音色设计" value={cfg.workflows.tts} />
              <ReadonlyRow label="背景音乐" value={cfg.workflows.music} />
            </div>
          )}

          {hwMode === 'amd' ? (
            <div className="flex flex-col gap-2 rounded-xl border border-[color-mix(in_srgb,var(--danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--danger)_5%,transparent)] p-3.5">
              <Field
                label="每 N 个生成后释放 ComfyUI 显存（0 = 关闭）"
                hint="利：避免 AMD Dynamic VRAM 连续生成后逐步变慢。弊：每次释放后下一次生成多花 1 - 3 分钟重载模型。"
              >
                <Input
                  type="number"
                  min={0}
                  max={20}
                  value={String(cfg.generation.freeAfterEvery ?? 0)}
                  onChange={(e) =>
                    setCfg({ ...cfg, generation: { ...cfg.generation, freeAfterEvery: Math.max(0, Math.min(20, Math.round(Number(e.target.value) || 0))) } })
                  }
                  className="w-24"
                />
              </Field>
              {comfyInfo && comfyInfo.ok === false ? (
                <p className="m-0 text-[11px] text-[var(--fg-3)]">当前 ComfyUI 连接失败，无法判断 Dynamic VRAM 状态，建议先测试连接。</p>
              ) : null}
              {comfyInfo && comfyInfo.ok && !comfyInfo.dynamicVram && (cfg.generation.freeAfterEvery ?? 0) > 0 ? (
                <p className="m-0 text-[11px] text-[var(--accent)]">检测到 ComfyUI 未启用 Dynamic VRAM，连续生成不会产生退化，建议把 N 设为 0。</p>
              ) : null}
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section icon={Wand2} title="技能库" description="扩展 Agent 的剧本、分镜与提示词能力">
        <SkillsPanel />
      </Section>

      <Section icon={Users} title="账号管理" description="登录账号与项目归属（管理员）">
        <UsersPanel />
      </Section>

      {dirty ? (
        <div className="sticky bottom-4 z-40 flex items-center justify-between gap-3 rounded-xl border border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--panel)_92%,var(--accent)_8%)] px-4 py-2.5 shadow-[0_20px_50px_-20px_rgba(0,0,0,.95)] backdrop-blur">
          <span className="flex items-center gap-2 text-[12px] text-[var(--fg-2)]">
            <Badge tone="accent" dot>未保存</Badge>
            配置有修改，保存后生效
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCfg(savedCfg)}>
              放弃修改
            </Button>
            <Button variant="primary" size="sm" loading={saving} onClick={save}>
              <Save size={13} /> 保存
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Section({ icon: Icon, title, description, children }) {
  return (
    <section className="panel flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)]">
          <Icon size={15} />
        </span>
        <div className="min-w-0">
          <h2 className="m-0 text-[14px] font-semibold text-[var(--fg)]">{title}</h2>
          {description ? <p className="m-0 mt-0.5 text-[11.5px] text-[var(--fg-3)]">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function TestResult({ text }) {
  if (!text) return null;
  const ok = text.includes('成功');
  return (
    <span className={ok ? 'flex items-center gap-1.5 text-[11.5px] text-[var(--success)]' : 'flex items-center gap-1.5 text-[11.5px] text-[var(--danger)]'}>
      {ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
      {text}
    </span>
  );
}

function ReadonlyRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11.5px]">
      <span className="text-[var(--fg-4)]">{label}</span>
      <span className="truncate font-mono text-[10.5px] text-[var(--fg-2)]" title={value}>
        {value || '—'}
      </span>
    </div>
  );
}
