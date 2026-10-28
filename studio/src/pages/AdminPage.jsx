import { useCallback, useEffect, useState } from 'react';import { Film, KeyRound, LayoutGrid, Lock, LogOut, Receipt, Save, Settings2, ShieldCheck, Users } from 'lucide-react';
import { api } from '../lib/api.js';
import { clearAuthToken, authHeaders } from '../lib/auth.js';
import { invalidateBilling } from '../lib/billing.js';
import { Badge, Button, Field, Input, Select, Switch, Textarea } from '../components/ui.jsx';
import { Modal } from '../components/overlays.jsx';
import UsersPanel from '../components/UsersPanel.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useToast } from '../components/toast.jsx';

const TABS = [
  { key: 'users', label: '用户与权限', icon: Users },
  { key: 'sso', label: 'JWT 接入', icon: KeyRound },
  { key: 'billing', label: '计费', icon: Receipt },
  { key: 'moderation', label: '内容审核', icon: ShieldCheck },
  { key: 'features', label: '界面功能', icon: LayoutGrid },
  { key: 'showcase', label: '展示内容', icon: Film },
  { key: 'access', label: '访问控制', icon: Lock },
];
const FEATURE_TABS = [
  ['workflow', '流程'],
  ['chapters', '章节管理'],
  ['assets', '素材库'],
  ['shots', '分镜审查'],
  ['music', '背景音乐'],
  ['exports', '成片'],
  ['logs', '运行日志'],
];
const FEATURE_CATEGORIES = [
  ['character', '角色'],
  ['scene', '场景'],
  ['prop', '道具'],
  ['costume', '服装'],
  ['age', '年龄'],
  ['voice', '音色'],
  ['music', '音乐'],
  ['sfx', '音效'],
  ['other', '其他'],
];
const FEATURE_BUTTONS = [
  ['generate', '生成 / 重新生成'],
  ['export', '导出 / 打包'],
  ['upload', '上传 / 替换素材'],
  ['delete', '删除'],
  ['projectSettings', '项目设置'],
  ['login', '登录入口'],
  ['github', 'GitHub 入口'],
];
const AUTH_MODES = [  {
    value: 'true',
    title: '对外服务 / 嵌入业务',
    desc: '需要登录。部署到自己的网站、通过 iframe 嵌入自有平台时选这个；配合 JWT 单点登录与计费使用。',
    danger: false,
  },
  {
    value: 'false',
    title: '开源自托管 / 自用',
    desc: '免登录使用；普通浏览与创作接口不需要登录，管理后台 /admin 仍需管理员账号密码。适合开发者本地或内网自用，不要直接暴露公网。',
    danger: true,
  },
  {
    value: '',
    title: '跟随启动脚本',
    desc: '由 IC_AUTH 决定：start-studio.bat 默认需要登录；直接 npm run dev 默认免登录。',
    danger: false,
  },
];
const KIND_LABEL = {
  t2i: '资产图',
  i2i: '图生图',
  r2v: '分镜视频',
  tts: '音色',
  music: '背景音乐',
  'llm-rewrite': '提示词改写',
};
const ALG_ITEMS = [
  { value: 'HS256', label: 'HS256（共享密钥）' },
  { value: 'RS256', label: 'RS256（公钥）' },
];
const PRICE_FIELDS = [
  { key: 'llmPerChapter', label: 'LLM 创作（每章）' },
  { key: 'llmRewritePerCall', label: 'LLM 改写提示词（每次）' },
  { key: 'imagePerAsset', label: '资产图（每张）' },
  { key: 'ttsPerVoice', label: '音色（每个）' },
  { key: 'videoPerSecond', label: '分镜视频（每秒）' },
  { key: 'musicPerTrack', label: '背景音乐（每首）' },
  { key: 'exportPerChapter', label: '合成 / 导出（每章）' },
];

export default function AdminPage({ onBack }) {
  const toast = useToast();
  const [tab, setTab] = useState('users');
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [baiduTest, setBaiduTest] = useState(null);
  const [baiduTesting, setBaiduTesting] = useState(false);
  const [usage, setUsage] = useState(null);
  const [wallets, setWallets] = useState([]);
  const [walletAmounts, setWalletAmounts] = useState({});
  const [projects, setProjects] = useState(null);
  const [confirmNoAuth, setConfirmNoAuth] = useState(false);
  const [modStatus, setModStatus] = useState(null);

  const load = useCallback(() => {
    setErr('');
    api
      .get('/api/config')
      .then(setCfg)
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const loadModStatus = useCallback(() => {
    api
      .get('/api/moderation/status')
      .then(setModStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (tab === 'moderation') loadModStatus();
  }, [tab, loadModStatus]);

  const loadWallets = useCallback(() => {
    api
      .get('/api/billing/wallets')
      .then((r) => setWallets(r.items || []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (tab === 'billing') loadWallets();
  }, [tab, loadWallets]);

  useEffect(() => {
    if (tab !== 'billing') return;
    let alive = true;
    api
      .get('/api/billing/usage')
      .then((r) => alive && setUsage(r))
      .catch(() => alive && setUsage({ items: [], stats: [] }));
    return () => {
      alive = false;
    };
  }, [tab]);

  useEffect(() => {
    if (tab !== 'showcase') return;
    let alive = true;
    api
      .get('/api/projects?pageSize=200')
      .then((r) => alive && setProjects(r.items || []))
      .catch(() => alive && setProjects([]));
    return () => {
      alive = false;
    };
  }, [tab]);

  async function toggleShowcase(p) {
    const next = !(p.is_public !== false);
    try {
      await api.patch('/api/projects/' + encodeURIComponent(p.id), { is_public: next });
      setProjects((list) => (list || []).map((x) => (x.id === p.id ? { ...x, is_public: next } : x)));
      toast.success(next ? '已加入展示' : '已取消展示');
    } catch (e) {
      toast.error(e.message);
    }
  }

  const sso = cfg?.auth?.sso || {};
  const billing = cfg?.billing || {};
  const wallet = billing.wallet || {};
  const moderation = cfg?.moderation || {};
  const baidu = cfg?.moderation?.baidu || {};
  const textCfg = moderation.text || {};
  // 配置为 null 时显示「实际生效值」；实际值来自 /api/moderation/status（后台看不到环境变量）
  const totalConfigured = typeof moderation.enabled === 'boolean' ? moderation.enabled : null;
  const textConfigured = typeof textCfg.enabled === 'boolean' ? textCfg.enabled : null;
  const totalChecked = totalConfigured !== null ? totalConfigured : !!modStatus?.total;
  const textChecked = !totalChecked ? false : (textConfigured !== null ? textConfigured : (modStatus?.text ?? true));
  const failClosedMode = typeof moderation.failClosed === 'boolean' ? String(moderation.failClosed) : 'auto';
  const features = cfg?.features || {};
  const authCfg = cfg?.auth || {};
  const authModeValue = typeof authCfg.enabled === 'boolean' ? String(authCfg.enabled) : '';
  const serverHost = String(cfg?.server?.host || '127.0.0.1');
  const hostExposed = !['127.0.0.1', 'localhost', '::1'].includes(serverHost);
  const setSso = (patch) => setCfg((c) => ({ ...c, auth: { ...(c.auth || {}), sso: { ...(c.auth?.sso || {}), ...patch } } }));
  const setBilling = (patch) => setCfg((c) => ({ ...c, billing: { ...(c.billing || {}), ...patch } }));
  const setWallet = (patch) =>
    setCfg((c) => ({
      ...c,
      billing: { ...(c.billing || {}), wallet: { ...(c.billing?.wallet || {}), ...patch } },
    }));
  async function topUp(userId) {
    const amount = Number(walletAmounts[userId]);
    if (!Number.isFinite(amount) || amount === 0) return toast.error('请输入非 0 的积分数');
    try {
      await api.post('/api/billing/wallets', { userId, amount, note: '管理员调整' });
      setWalletAmounts((m) => ({ ...m, [userId]: '' }));
      loadWallets();
      toast.success('积分已更新');
    } catch (e) {
      toast.error(e.message);
    }
  }
  const setModeration = (patch) =>
    setCfg((c) => ({ ...c, moderation: { ...(c.moderation || {}), ...patch } }));
  const setModerationText = (patch) =>
    setCfg((c) => ({
      ...c,
      moderation: {
        ...(c.moderation || {}),
        text: { ...(c.moderation?.text || {}), ...patch },
      },
    }));
  const setBaidu = (patch) =>
    setCfg((c) => ({ ...c, moderation: { ...(c.moderation || {}), baidu: { ...(c.moderation?.baidu || {}), ...patch } } }));
  const setFeature = (key, value) =>
    setCfg((c) => ({ ...c, features: { ...(c.features || {}), [key]: value } }));
  const setFeatureTab = (key, value) =>
    setCfg((c) => ({
      ...c,
      features: { ...(c.features || {}), tabs: { ...(c.features?.tabs || {}), [key]: value } },
    }));
  const setFeatureCategory = (key, value) =>
    setCfg((c) => ({
      ...c,
      features: {
        ...(c.features || {}),
        assetCategories: { ...(c.features?.assetCategories || {}), [key]: value },
      },
    }));
  const setFeatureButton = (key, value) =>
    setCfg((c) => ({
      ...c,
      features: { ...(c.features || {}), buttons: { ...(c.features?.buttons || {}), [key]: value } },
    }));
  const setAuthMode = (value) =>
    setCfg((c) => ({
      ...c,
      auth: { ...(c.auth || {}), enabled: value === '' ? null : value === 'true' },
    }));
  const setPrice = (key, value) => setBilling({ prices: { ...(billing.prices || {}), [key]: value } });

  async function testBaidu() {
    setBaiduTesting(true);
    setBaiduTest(null);
    try {
      const r = await api.post('/api/moderation/baidu/test', { baidu });
      setBaiduTest(r);
    } catch (e) {
      setBaiduTest({ ok: false, error: e.message });
    } finally {
      setBaiduTesting(false);
    }
  }

  async function save() {
    const prevAuthMode = typeof cfg?.auth?.enabled === 'boolean' ? cfg.auth.enabled : null;
    setSaving(true);
    try {
      const r = await api.put('/api/config', cfg);
      setCfg(r);
      invalidateBilling();
      if (tab === 'moderation') loadModStatus();
      const nextAuthMode = typeof r?.auth?.enabled === 'boolean' ? r.auth.enabled : null;
      if (prevAuthMode !== nextAuthMode) {
        // 登录模式变了：App 的 authEnabled 是启动时读的，必须整页重载，
        // 否则首页仍会按旧模式显示登录入口/账号菜单。
        toast.success('已保存，正在刷新界面…');
        setTimeout(() => window.location.reload(), 500);
        return;
      }
      toast.success('已保存，配置立即生效');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const activeTab = TABS.find((t) => t.key === tab) || TABS[0];
  const ActiveIcon = activeTab.icon;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Admin"
        title="管理后台"
        description="账号与功能权限、JWT 单点登录接入、按节点的费用提醒与用量回传。"
        actions={
          <>
            {onBack ? (
              <Button variant="ghost" size="md" onClick={onBack}>
                返回项目列表
              </Button>
            ) : null}
            <Button variant="primary" size="md" loading={saving} disabled={!cfg || saving} onClick={save}>
              <Save size={14} /> 保存配置
            </Button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="panel h-fit p-2 lg:sticky lg:top-[86px]">
          <p className="section-label px-2.5 pb-2 pt-2">Admin</p>
          <div className="flex flex-col gap-1">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  type="button"
                  data-active={tab === t.key}
                  className="nav-item"
                  onClick={() => setTab(t.key)}
                >
                  <Icon size={14} className={tab === t.key ? 'text-[var(--accent)]' : 'text-[var(--fg-3)]'} />
                  <span className="flex-1 text-left">{t.label}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-2 border-t border-[var(--line)] pt-2">
            <button
              type="button"
              className="nav-item"
              onClick={() => window.location.assign('/?view=settings')}
            >
              <Settings2 size={14} className="text-[var(--fg-3)]" />
              <span className="flex-1 text-left">系统设置</span>
            </button>
            <button
              type="button"
              className="nav-item text-[var(--fg-3)] hover:text-[var(--danger)]"
              onClick={async () => {
                try {
                  await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
                } catch {
                  /* 忽略网络错误，仍清理本地令牌 */
                }
                clearAuthToken();
                window.location.assign('/');
              }}
            >
              <LogOut size={14} />
              <span className="flex-1 text-left">退出管理登录</span>
            </button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--line)] bg-white/[0.03] text-[var(--accent)]">
              <ActiveIcon size={15} />
            </span>
            <div>
              <h2 className="m-0 text-[15px] font-semibold tracking-[-.01em] text-[var(--fg)]">{activeTab.label}</h2>
              <p className="m-0 text-[10.5px] text-[var(--fg-4)]">左侧切换管理项，修改后点右上角「保存配置」生效。</p>
            </div>
          </div>

          {err ? <p className="m-0 text-[12px] text-[var(--danger)]">配置加载失败：{err}</p> : null}

      {tab === 'users' ? <UsersPanel /> : null}

      {tab === 'sso' && cfg ? (
        <div className="flex flex-col gap-4">
          <div className="panel flex flex-col gap-4 p-4">
            <Switch
              checked={!!sso.enabled}
              onChange={(v) => setSso({ enabled: v })}
              label="启用 JWT 单点登录"
              hint="父平台 iframe 通过 ?jwt=<token> 或 postMessage 传入短时 JWT，验签后自动登录。独立部署请保持关闭。"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="签名算法">
                <Select value={sso.algorithm || 'HS256'} onChange={(v) => setSso({ algorithm: v })} items={ALG_ITEMS} />
              </Field>
              <Field label="Issuer（可选）" hint="校验 JWT 的 iss 字段">
                <Input value={sso.issuer || ''} onChange={(e) => setSso({ issuer: e.target.value })} placeholder="https://parent.example.com" />
              </Field>
              <Field label="Audience（可选）" hint="校验 JWT 的 aud 字段">
                <Input value={sso.audience || ''} onChange={(e) => setSso({ audience: e.target.value })} placeholder="infinite-creation" />
              </Field>
              <Field label="时钟容差（秒）">
                <Input type="number" min={0} max={300} value={String(sso.clockToleranceSec ?? 30)} onChange={(e) => setSso({ clockToleranceSec: num(e.target.value) })} className="w-28" />
              </Field>
            </div>
            {(sso.algorithm || 'HS256') === 'HS256' ? (
              <Field label="共享密钥（HS256）" hint="与父平台签发端使用同一个 secret">
                <Input type="password" value={sso.secret || ''} onChange={(e) => setSso({ secret: e.target.value })} placeholder="填写后即可启用" />
              </Field>
            ) : (
              <Field label="公钥（RS256，PEM）" hint="粘贴父平台签名公钥，含 BEGIN/END PUBLIC KEY">
                <Textarea value={sso.publicKey || ''} onChange={(e) => setSso({ publicKey: e.target.value })} rows={6} placeholder={'-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----'} />
              </Field>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="用户 ID claim" hint="默认 sub">
                <Input value={sso.userIdClaim || ''} onChange={(e) => setSso({ userIdClaim: e.target.value })} placeholder="sub" />
              </Field>
              <Field label="用户名 claim">
                <Input value={sso.usernameClaim || ''} onChange={(e) => setSso({ usernameClaim: e.target.value })} placeholder="username" />
              </Field>
              <Field label="角色 claim" hint="admin / creator / viewer">
                <Input value={sso.roleClaim || ''} onChange={(e) => setSso({ roleClaim: e.target.value })} placeholder="role" />
              </Field>
              <Field label="权限 claim（可选）" hint={'对象形式，如 {"generate":true}'}>
                <Input value={sso.permsClaim || ''} onChange={(e) => setSso({ permsClaim: e.target.value })} placeholder="perms" />
              </Field>
              <Field label="父页面来源白名单（可选）" hint="逗号分隔；留空不限制。例：https://app.example.com">
                <Input
                  value={(sso.allowedOrigins || []).join(', ')}
                  onChange={(e) =>
                    setSso({ allowedOrigins: e.target.value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) })
                  }
                  placeholder="https://app.example.com"
                />
              </Field>
            </div>
            {sso.enabled && !sso.secret && !sso.publicKey ? (
              <p className="m-0 rounded-lg border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2 text-[11.5px] text-[var(--danger)]">
                已启用但还没填密钥/公钥，SSO 登录会失败。
              </p>
            ) : null}
            <div className="rounded-xl border border-[var(--line)] bg-black/20 p-3">
              <p className="m-0 text-[11px] font-medium text-[var(--fg-2)]">父平台嵌入示例</p>
              <pre className="mt-2 overflow-x-auto text-[10.5px] leading-relaxed text-[var(--fg-3)]">{`<iframe
  src="http://你的Studio地址:4710/?jwt=<父平台签发的短时JWT>&embed=1"
  width="100%" height="900" style="border:0"
></iframe>`}</pre>
              <p className="m-0 mt-2 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
                也可以不带 jwt 参数，由父页面通过 postMessage 发送 <code className="font-mono">{`{ type: 'studio:sso', jwt: '...' }`}</code>。
                JWT 建议有效期 ≤ 10 分钟；Studio 换取本地会话后会把 jwt 从地址栏移除。
              </p>
            </div>
            <div className="flex justify-end">
              <Button variant="primary" size="md" loading={saving} onClick={save}>
                <Save size={14} /> 保存配置
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'billing' && cfg ? (
        <div className="flex flex-col gap-4">
          <div className="panel flex flex-col gap-4 p-4">
            <div>
              <p className="m-0 text-[12px] font-medium text-[var(--fg-2)]">本地积分钱包</p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
                开启后，每个计费步骤在提交前先从余额预扣（实点实扣）：成功转成用量，失败/取消自动退回。余额不够时当前步骤不提交，任务停止并保留已完成内容。
              </p>
            </div>
            <Switch
              checked={!!wallet.enabled}
              onChange={(v) => setWallet({ enabled: v })}
              label="启用本地积分预扣"
              hint="建议先给账号充值再开启；关闭时保持原来的父平台余额校验 + 后付费。"
            />
            <Switch
              checked={!!wallet.requireFullEstimate}
              onChange={(v) => setWallet({ requireFullEstimate: v })}
              label="整章预算不足时禁止开始"
              hint="关闭（推荐）：允许部分执行，扣到不够自动停；开启：整章预计费用不够就一步都不跑。"
            />
            <div className="overflow-x-auto rounded-xl border border-[var(--line)]">
              <table className="w-full min-w-[560px] text-[11.5px]">
                <thead className="bg-white/[0.03] text-[var(--fg-3)]">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">账号</th>
                    <th className="px-3 py-2 text-right font-medium">可用余额</th>
                    <th className="px-3 py-2 text-right font-medium">在途</th>
                    <th className="px-3 py-2 text-right font-medium">调整积分</th>
                  </tr>
                </thead>
                <tbody>
                  {wallets.map((w) => {
                    const bal = w.wallet || {};
                    return (
                      <tr key={w.id} className="border-t border-[var(--line)]">
                        <td className="px-3 py-2">
                          <span className="text-[var(--fg-2)]">{w.username}</span>
                          <span className="ml-2 text-[10px] text-[var(--fg-4)]">{w.role}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[var(--fg)]">{bal.balance ?? 0} {bal.currency || billing.currency || '点'}</td>
                        <td className="px-3 py-2 text-right font-mono text-[var(--fg-4)]">{bal.held ?? 0}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-2">
                            <Input
                              value={walletAmounts[w.id] || ''}
                              onChange={(e) => setWalletAmounts((m) => ({ ...m, [w.id]: e.target.value }))}
                              placeholder="+100 / -50"
                              className="w-28"
                            />
                            <Button variant="secondary" size="sm" onClick={() => topUp(w.id)}>调整</Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!wallets.length ? <tr><td colSpan={4} className="px-3 py-3 text-[var(--fg-4)]">还没有账号</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end">
              <Button variant="primary" size="md" loading={saving} onClick={save}>
                <Save size={14} /> 保存配置
              </Button>
            </div>
          </div>
          <div className="panel flex flex-col gap-4 p-4">
            <Switch
              checked={!!billing.showCost}
              onChange={(v) => setBilling({ showCost: v })}
              label="在生成按钮上显示预估费用"
              hint="按下面的价目表 × 本次数量/时长估算。关闭后按钮不显示任何费用。"
            />
            <Switch
              checked={!!billing.enforceBalance}
              onChange={(v) => setBilling({ enforceBalance: v })}
              label="提交前校验余额（预留）"
              hint="开启后需父平台提供余额接口；未接入前仅作为配置项保留。"
            />
            <Switch
              checked={!!billing.chargeExport}
              onChange={(v) => setBilling({ chargeExport: v })}
              label="导出 / 合成也计费"
              hint="开启后，导出成片、应用背景音乐重合成会按「合成/导出（每章）」价目记账；下载不另收。"
            />
            <Field
              label="云端任务取消/失败计费"
              hint="OpenAPI 只返回任务状态，不返回实际扣点；这里按“是否已开始运行”决定是否仍向用户计费。"
            >
              <Select
                value={billing.providerCancelPolicy || 'charge_if_started'}
                onChange={(v) => setBilling({ providerCancelPolicy: v })}
                items={[
                  { value: 'charge_if_started', label: '已开始/失败/超时仍计费（推荐）' },
                  { value: 'always_refund', label: '取消/失败一律退回' },
                  { value: 'always_charge', label: '提交成功即计费' },
                ]}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="货币单位" hint="显示在费用后面的文字">
                <Input value={billing.currency || ''} onChange={(e) => setBilling({ currency: e.target.value })} placeholder="点" className="w-28" />
              </Field>
              <Field label="用量回传地址（预留）" hint="任务结束后 POST 用量与费用">
                <Input value={billing.reportUrl || ''} onChange={(e) => setBilling({ reportUrl: e.target.value })} placeholder="https://parent.example.com/api/usage" />
              </Field>
              <Field label="回传鉴权（预留）">
                <Input type="password" value={billing.reportToken || ''} onChange={(e) => setBilling({ reportToken: e.target.value })} placeholder="Bearer token" />
              </Field>
              <Field label="余额校验接口（可选）" hint="开启「提交前校验余额」后，提交前 POST {userId, amount, currency}">
                <Input value={billing.balanceUrl || ''} onChange={(e) => setBilling({ balanceUrl: e.target.value })} placeholder="https://parent.example.com/api/balance" />
              </Field>
              <Field label="余额接口鉴权">
                <Input type="password" value={billing.balanceToken || ''} onChange={(e) => setBilling({ balanceToken: e.target.value })} placeholder="Bearer token" />
              </Field>
              <Field label="每人每日额度" hint="0 = 不限制；单位同货币">
                <Input type="number" min={0} value={String(billing.dailyLimit ?? 0)} onChange={(e) => setBilling({ dailyLimit: num(e.target.value) })} className="w-28" />
              </Field>
              <Field label="每人每月额度" hint="0 = 不限制">
                <Input type="number" min={0} value={String(billing.monthlyLimit ?? 0)} onChange={(e) => setBilling({ monthlyLimit: num(e.target.value) })} className="w-28" />
              </Field>
              <Field label="回传失败重试次数" hint="按 1/2/4/8/16 分钟退避">
                <Input type="number" min={1} max={20} value={String(billing.reportRetryTimes ?? 5)} onChange={(e) => setBilling({ reportRetryTimes: Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 5))) })} className="w-28" />
              </Field>
            </div>
            <div>
              <p className="m-0 text-[12px] font-medium text-[var(--fg-2)]">节点价目表</p>
              <p className="mt-1 text-[11px] text-[var(--fg-4)]">0 表示该节点不显示费用。数量/时长为 0 时按钮也不会显示。</p>
              <p className="mt-1 text-[11px] text-[var(--fg-3)]">
                当前计价单位：<b>{billing.currency || '点'}</b>。父平台可直接把回传里的 amount 当作金币数扣减。
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {PRICE_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={String(billing.prices?.[f.key] ?? 0)}
                      onChange={(e) => setPrice(f.key, num(e.target.value))}
                      className="w-28"
                    />
                  </Field>
                ))}
              </div>
            </div>

            {usage ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <p className="m-0 text-[12px] font-medium text-[var(--fg-2)]">最近用量</p>
                  <span className="text-[10.5px] text-[var(--fg-4)]">近 30 天汇总</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {usage.stats?.length ? (
                    usage.stats.map((s) => (
                      <Badge key={s.kind + s.currency} tone="neutral">
                        {KIND_LABEL[s.kind] || s.kind}：{s.count} 次 / {s.amount} {s.currency}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-[11px] text-[var(--fg-4)]">暂无记录（只有配置了价格且完成的渲染会记账）</span>
                  )}
                </div>
                {usage.items?.length ? (
                  <div className="flex flex-col divide-y divide-[var(--line)] rounded-xl border border-[var(--line)]">
                    {usage.items.slice(0, 10).map((u) => (
                      <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px] text-[var(--fg-3)]">
                        <span className="font-mono text-[10px]">{new Date(u.createdAt).toLocaleString('zh-CN')}</span>
                        <span>{KIND_LABEL[u.kind] || u.kind} × {u.quantity}</span>
                        <span className="text-[var(--accent)]">{u.amount} {u.currency}</span>
                        <span className={u.reported ? 'text-[var(--success)]' : 'text-[var(--fg-4)]'}>{u.reported ? '已回传' : '未回传'}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {!billing.showCost && Object.values(billing.prices || {}).some((v) => Number(v) > 0) ? (
              <p className="m-0 rounded-lg border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--danger)]">
                价目表已填写，但「显示预估费用」还是关闭状态——按钮上不会出现任何金额。打开上面的开关并保存即可。
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={billing.showCost ? 'success' : 'neutral'}>{billing.showCost ? '费用提醒已开启' : '费用提醒已关闭'}</Badge>
              <span className="text-[10.5px] text-[var(--fg-4)]">改完点下方「保存配置」即时生效。</span>
            </div>
            <div className="flex justify-end">
              <Button variant="primary" size="md" loading={saving} onClick={save}>
                <Save size={14} /> 保存配置
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {tab === 'moderation' && cfg ? (
        <div className="flex flex-col gap-4">
          <div className="panel flex flex-col gap-4 p-4">
            <div>
              <p className="m-0 text-[12px] font-medium text-[var(--fg-2)]">内容审核总开关</p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
                关闭后文本与图片审核全部停用；下面的分项开关只在总开关开启时生效。
              </p>
            </div>
            <Switch
              checked={totalChecked}
              onChange={(v) => setModeration({ enabled: v })}
              label={totalChecked ? '内容审核已开启' : '内容审核已关闭'}
              hint={
                '总开关。' +
                (totalConfigured === null
                  ? '当前跟随环境变量 IC_MODERATION（' + (modStatus?.env?.IC_MODERATION ? '已开启' : '未开启') + '），拨动后变为后台强制值。'
                  : '当前由后台强制' + (totalConfigured ? '开启' : '关闭') + '，不受启动参数影响。')
              }
            />
            {totalConfigured !== null ? (
              <button
                type="button"
                onClick={() => setModeration({ enabled: null })}
                className="self-start text-[11px] text-[var(--fg-3)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
              >
                恢复跟随环境变量
              </button>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Switch
                checked={textChecked}
                onChange={(v) => setModerationText({ enabled: v })}
                disabled={!totalChecked}
                label="文本内容审核"
                hint={
                  '词表只作线索，DeepSeek 按整段语义判断（模型：' + (cfg?.llm?.model || '未配置') + '）。'
                  + (totalChecked ? '' : '总开关关闭时不可用。')
                }
              />
              <Field label="审核服务异常时" hint="模型超时/返回异常时的策略；内容命中始终拦截">
                <Select
                  value={failClosedMode}
                  onChange={(v) => setModeration({ failClosed: v === 'auto' ? null : v === 'true' })}
                  items={[
                    { value: 'auto', label: '跟随环境变量' },
                    { value: 'true', label: '拦截（推荐）' },
                    { value: 'false', label: '放行' },
                  ]}
                />
              </Field>
            </div>
            {textConfigured !== null ? (
              <button
                type="button"
                onClick={() => setModerationText({ enabled: null })}
                className="self-start text-[11px] text-[var(--fg-3)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
              >
                文本审核恢复跟随总开关
              </button>
            ) : null}
            <p className="m-0 rounded-lg border border-[var(--line)] bg-white/[0.02] px-3 py-2 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
              保存后立即生效。关闭总开关后，文本写入与图片替换都不再送审。
            </p>
          </div>
          <div className="panel flex flex-col gap-4 p-4">
            <Switch
              checked={!!baidu.enabled}
              onChange={(v) => setBaidu({ enabled: v })}
              disabled={!totalChecked}
              label="图片内容审核（百度）"
              hint={'只有「替换已有图片」这个动作会送审；首次上传、生成图片都不会调用。' + (totalChecked ? '' : '总开关关闭时不可用。')}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="API Key">
                <Input value={baidu.apiKey || ''} onChange={(e) => setBaidu({ apiKey: e.target.value })} placeholder="百度智能云应用 API Key" />
              </Field>
              <Field label="Secret Key">
                <Input type="password" value={baidu.secretKey || ''} onChange={(e) => setBaidu({ secretKey: e.target.value })} placeholder="Secret Key" />
              </Field>
              <Field label="策略 ID（可选）" hint="百度控制台的自定义策略；留空使用默认策略">
                <Input value={baidu.strategyId || ''} onChange={(e) => setBaidu({ strategyId: e.target.value })} placeholder="例如 1" className="w-28" />
              </Field>
            </div>
            <Switch
              checked={baidu.failClosed !== false}
              onChange={(v) => setBaidu({ failClosed: v })}
              label="审核服务异常时拒绝替换"
              hint="开启（推荐）：接口超时/鉴权失败时直接拒绝替换；关闭：记录日志并放行。"
            />
            <details className="rounded-lg border border-[var(--line)] px-3 py-2">
              <summary className="cursor-pointer text-[11.5px] text-[var(--fg-3)]">高级：接口地址（联调 / 私有代理）</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="审核接口" hint="留空使用百度官方接口">
                  <Input value={baidu.endpoint || ''} onChange={(e) => setBaidu({ endpoint: e.target.value })} placeholder="https://aip.baidubce.com/rest/2.0/solution/v1/img_censor/v2/user_defined" />
                </Field>
                <Field label="鉴权接口" hint="留空使用百度官方接口">
                  <Input value={baidu.tokenEndpoint || ''} onChange={(e) => setBaidu({ tokenEndpoint: e.target.value })} placeholder="https://aip.baidubce.com/oauth/2.0/token" />
                </Field>
              </div>
            </details>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="md" loading={baiduTesting} onClick={testBaidu}>
                测试连接
              </Button>
              {baiduTest ? (
                <span className={'text-[11.5px] ' + (baiduTest.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]')}>
                  {baiduTest.ok ? '鉴权成功，密钥可用' : '失败：' + (baiduTest.error || '未知错误')}
                </span>
              ) : null}
            </div>
            <div className="flex justify-end">
              <Button variant="primary" size="md" loading={saving} onClick={save}>
                <Save size={14} /> 保存配置
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {tab === 'features' && cfg ? (
        <div className="flex flex-col gap-4">
          <div className="panel flex flex-col gap-4 p-4">
            <p className="m-0 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
              以下开关只控制 Studio 界面上是否显示对应入口，<b>不改变权限和接口行为</b>：隐藏后接口仍然受角色/功能权限校验。
            </p>
            <div>
              <p className="m-0 text-[12px] font-medium text-[var(--fg-2)]">项目页 Tab</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {FEATURE_TABS.map(([key, label]) => (
                  <Switch
                    key={key}
                    checked={features.tabs?.[key] !== false}
                    onChange={(v) => setFeatureTab(key, v)}
                    label={label}
                  />
                ))}
              </div>
            </div>
            <div className="hairline" />
            <div>
              <p className="m-0 text-[12px] font-medium text-[var(--fg-2)]">素材分类</p>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--fg-4)]">
                关闭后素材库筛选、新建资产、分镜素材选择都不再出现该分类；已有数据不会删除。
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {FEATURE_CATEGORIES.map(([key, label]) => (
                  <Switch
                    key={key}
                    checked={features.assetCategories?.[key] !== false}
                    onChange={(v) => setFeatureCategory(key, v)}
                    label={label}
                  />
                ))}
              </div>
            </div>
            <div className="hairline" />
            <div>
              <p className="m-0 text-[12px] font-medium text-[var(--fg-2)]">操作按钮</p>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--fg-4)]">
                只控制界面是否显示；权限和接口校验不变，隐藏后接口仍会按角色拦截。
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {FEATURE_BUTTONS.map(([key, label]) => (
                  <Switch
                    key={key}
                    checked={features.buttons?.[key] !== false}
                    onChange={(v) => setFeatureButton(key, v)}
                    label={label}
                  />
                ))}
              </div>
            </div>
            <div className="hairline" />
            <Switch
              checked={features.taskDrawer !== false}
              onChange={(v) => setFeature('taskDrawer', v)}
              label="任务抽屉"
              hint="项目页右上角的「任务」按钮。关闭后仍会在任务状态变化时收到通知。"
            />
            <Switch
              checked={features.createProject !== false}
              onChange={(v) => setFeature('createProject', v)}
              label="新建项目入口"
              hint="关闭后列表页不再显示「新建项目」；已有项目不受影响。"
            />
            <Switch
              checked={features.settings !== false}
              onChange={(v) => setFeature('settings', v)}
              label="设置入口（仅管理员可见）"
              hint="设置页本来就只对管理员开放；关闭只隐藏顶栏入口，管理员仍可通过 ?view=settings 访问。"
            />
            <div className="flex justify-end">
              <Button variant="primary" size="md" loading={saving} onClick={save}>
                <Save size={14} /> 保存配置
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {tab === 'showcase' && cfg ? (
        <div className="flex flex-col gap-4">
          <div className="panel flex flex-col gap-4 p-4">
            <p className="m-0 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
              勾选要对外展示的项目。只有<b>归属管理员</b>的项目会出现在访客/普通用户的项目列表里；取消勾选后该项目只对管理员可见。
              素材分类与按钮显隐在「界面功能」里配置。
            </p>
            <div className="flex flex-col divide-y divide-[var(--line)] rounded-xl border border-[var(--line)]">
              {(projects || []).map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                  <div className="min-w-0">
                    <p className="m-0 truncate text-[12.5px] font-medium text-[var(--fg-2)]">{p.name}</p>
                    <p className="m-0 mt-0.5 text-[10.5px] text-[var(--fg-4)]">
                      {p.assetCount ?? 0} 素材 · {p.shotCount ?? 0} 分镜
                      {p.owner_id ? ' · 归属 ' + String(p.owner_id).slice(0, 8) : ' · 无归属'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[10.5px] text-[var(--fg-4)]">{p.is_public !== false ? '展示中' : '已隐藏'}</span>
                    <Switch checked={p.is_public !== false} onChange={() => toggleShowcase(p)} />
                  </div>
                </div>
              ))}
              {projects && !projects.length ? (
                <p className="m-0 px-3.5 py-4 text-[11.5px] text-[var(--fg-4)]">还没有项目</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {tab === 'access' && cfg ? (
        <div className="flex flex-col gap-4">
          <div className="panel flex flex-col gap-4 p-4">
            <div>
              <p className="m-0 text-[12px] font-medium text-[var(--fg-2)]">部署形态</p>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--fg-4)]">
                同一个项目有两种用法：你自己的业务（必须登录）和开源给其他开发者自托管（可以免登录）。按实际部署选，别把免登录版本直接暴露到公网。
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {AUTH_MODES.map((m) => {
                  const active = authModeValue === m.value;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => (m.value === 'false' ? setConfirmNoAuth(true) : setAuthMode(m.value))}
                      className={
                        'flex flex-col gap-2 rounded-xl border p-3.5 text-left transition-colors ' +
                        (active
                          ? m.danger
                            ? 'border-[color-mix(in_srgb,var(--danger)_55%,transparent)] bg-[color-mix(in_srgb,var(--danger)_7%,transparent)]'
                            : 'border-[color-mix(in_srgb,var(--accent)_55%,transparent)] bg-[color-mix(in_srgb,var(--accent)_7%,transparent)]'
                          : 'border-[var(--line)] bg-white/[0.015] hover:border-[var(--line-strong)]')
                      }
                    >
                      <span className="flex items-center gap-2">
                        <span className={'text-[12.5px] font-medium ' + (m.danger ? 'text-[var(--danger)]' : 'text-[var(--fg-2)]')}>{m.title}</span>
                        {active ? <Badge tone={m.danger ? 'danger' : 'accent'}>当前</Badge> : null}
                      </span>
                      <span className="text-[10.5px] leading-relaxed text-[var(--fg-4)]">{m.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {hostExposed ? (
              <p className="m-0 rounded-lg border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--danger)]">
                当前服务绑定地址是 {serverHost}（不是 127.0.0.1）。如果选「开源自托管 / 自用」，免登录权限会暴露到局域网或公网。
              </p>
            ) : null}
            {authModeValue === 'false' ? (
              <p className="m-0 rounded-lg border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--danger)]">
                当前选择免登录：浏览与创作不需要登录；管理后台仍必须用管理员账号登录，不会跟着一起开放。
              </p>
            ) : null}
            <div className="rounded-xl border border-[var(--line)] bg-black/20 p-3">
              <p className="m-0 text-[11px] font-medium text-[var(--fg-2)]">独立控制入口（需管理员登录）</p>
              <p className="m-0 mt-1 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
                后台进不去时，在服务器本机执行脚本切换（不经 HTTP）：
              </p>
              <pre className="mt-2 overflow-x-auto text-[10.5px] leading-relaxed text-[var(--fg-3)]">{`node scripts/set-auth-mode.mjs false   # false=免登录，true=需要登录
node scripts/set-auth-mode.mjs auto    # 跟随 IC_AUTH`}</pre>
              <p className="m-0 mt-2 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
                HTTP 接口 /api/auth/mode 始终要求管理员令牌，不再把「请求来自本机」当作免登录条件 —— 反向代理会把公网请求变成 127.0.0.1。
              </p>
            </div>
            <div className="flex justify-end">
              <Button variant="primary" size="md" loading={saving} onClick={save}>
                <Save size={14} /> 保存配置
              </Button>
            </div>
          </div>
        </div>
      ) : null}
        </div>
      </div>
      <Modal
        open={confirmNoAuth}
        onOpenChange={setConfirmNoAuth}
        title="确认切换为免登录？"
        description="这个模式对应「开源自托管 / 本机自用」，不是对外服务。"
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setConfirmNoAuth(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={() => {
                setAuthMode('false');
                setConfirmNoAuth(false);
              }}
            >
              确认免登录
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-[12px] leading-relaxed text-[var(--fg-2)]">
          <p className="m-0">免登录后，普通浏览与创作接口不再校验登录，任何能访问该服务的人都可以创建项目、消耗生成额度；管理后台 /admin 仍需管理员账号密码。</p>
          <p className="m-0">如果你的部署是对外网站，或通过 iframe 嵌入自有业务，请保持「对外服务 / 嵌入业务」。</p>
          {hostExposed ? (
            <p className="m-0 text-[var(--danger)]">
              当前绑定地址是 {serverHost}，不是回环地址，免登录会直接暴露给网络上的所有人。
            </p>
          ) : null}
          <p className="m-0 text-[var(--fg-4)]">确认后还需要点「保存配置」才会生效。</p>
        </div>
      </Modal>
    </div>
  );
}
