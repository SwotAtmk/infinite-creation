import { useCallback, useEffect, useMemo, useState } from 'react';
import { Receipt, RefreshCw } from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button, EmptyState, Field, Select, Spinner } from '../components/ui.jsx';
import PageHeader from '../components/PageHeader.jsx';

const KIND_LABEL = {
  llm: 'LLM 创作', 'llm-chapter': 'LLM 创作', 'llm-rewrite': 'LLM 改写',
  image: '资产图', t2i: '资产图', i2i: '资产图',
  tts: '音色', voice: '音色',
  r2v: '分镜视频', video: '分镜视频',
  music: '背景音乐', export: '合成 / 导出', assemble: '合成 / 导出',
};
const KIND_ITEMS = [
  { value: '', label: '全部类型' },
  { value: 'llm', label: 'LLM 创作' },
  { value: 'llm-rewrite', label: 'LLM 改写' },
  { value: 'image', label: '资产图' },
  { value: 'tts', label: '音色' },
  { value: 'r2v', label: '分镜视频' },
  { value: 'music', label: '背景音乐' },
  { value: 'export', label: '合成 / 导出' },
];
const DAY_ITEMS = [
  { value: '1', label: '今天' },
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: '0', label: '全部' },
];
const STATUS_LABEL = { done: '完成', failed: '失败', cancelled: '已取消', running: '运行中', queued: '排队中', interrupted: '已中断' };

function fmtTime(ts) {
  try { return new Date(Number(ts) || 0).toLocaleString(); } catch { return ''; }
}

export default function UsagePage({ onBack }) {
  const [data, setData] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [projects, setProjects] = useState([]);
  const [wallets, setWallets] = useState([]);
  const [userId, setUserId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState('');
  const [days, setDays] = useState('30');
  const [interrupted, setInterrupted] = useState(false);

  useEffect(() => {
    api.get('/api/projects').then((r) => setProjects((r.items || []).map((p) => ({ value: p.id, label: p.name })))).catch(() => {});
    api.get('/api/billing/wallets').then((r) => setWallets(r.items || [])).catch(() => {});
  }, []);

  const query = useCallback((offset) => {
    const p = new URLSearchParams();
    if (userId) p.set('userId', userId);
    if (projectId) p.set('projectId', projectId);
    if (kind) p.set('kind', kind);
    if (days) p.set('days', days);
    if (interrupted) p.set('interrupted', '1');
    p.set('limit', '50');
    p.set('offset', String(offset || 0));
    return api.get('/api/billing/usage?' + p.toString());
  }, [userId, projectId, kind, days, interrupted]);

  const load = useCallback(async (append = false) => {
    if (append) setMore(true); else setLoading(true);
    try {
      const r = await query(append ? items.length : 0);
      setData(r);
      setItems((prev) => (append ? [...prev, ...(r.items || [])] : (r.items || [])));
    } finally {
      setLoading(false);
      setMore(false);
    }
  }, [query, items.length]);

  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [userId, projectId, kind, days, interrupted]);

  const projectName = useMemo(() => {
    const m = new Map(projects.map((p) => [p.value, p.label]));
    return (id, fallback) => m.get(id) || fallback || id || '—';
  }, [projects]);
  const userName = useMemo(() => {
    const m = new Map(wallets.map((w) => [w.id, w.username]));
    return (id) => m.get(id) || id || '—';
  }, [wallets]);
  const account = data?.account;
  const isAdmin = !!data?.isAdmin;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Billing"
        title="消费记录"
        description="每一笔积分消耗、对应的项目/章节、任务状态和计费说明。中断后仍计费会单独标注。"
        actions={
          <div className="flex items-center gap-2">
            {onBack ? <Button variant="ghost" size="sm" onClick={onBack}>返回</Button> : null}
            <Button variant="secondary" size="sm" loading={loading} onClick={() => load(false)}>
              <RefreshCw size={13} /> 刷新
            </Button>
          </div>
        }
      />

      {account ? (
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            ['可用余额', account.balance, account.currency],
            ['在途预授权', account.held, account.currency],
            ['今日已用', account.todayUsed, account.currency],
            ['本月已用', account.monthUsed, account.currency],
          ].map(([label, value, cur]) => (
            <div key={label} className="panel px-4 py-3">
              <p className="m-0 text-[10.5px] text-[var(--fg-4)]">{label}</p>
              <p className="m-0 mt-1 font-mono text-[16px] text-[var(--fg)]">{value} <span className="text-[11px] text-[var(--fg-3)]">{cur || ''}</span></p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="panel flex flex-col gap-3 p-4">
        <div className="grid gap-3 md:grid-cols-4">
          {isAdmin ? (
            <Field label="账号">
              <Select
                value={userId}
                onChange={setUserId}
                items={[{ value: '', label: '全部账号' }, ...wallets.map((w) => ({ value: w.id, label: w.username }))]}
              />
            </Field>
          ) : null}
          <Field label="项目">
            <Select value={projectId} onChange={setProjectId} items={[{ value: '', label: '全部项目' }, ...projects]} />
          </Field>
          <Field label="类型">
            <Select value={kind} onChange={setKind} items={KIND_ITEMS} />
          </Field>
          <Field label="时间">
            <Select value={days} onChange={setDays} items={DAY_ITEMS} />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={interrupted ? 'danger' : 'secondary'}
            size="sm"
            onClick={() => setInterrupted((v) => !v)}
          >
            {interrupted ? '只看中断计费（已开启）' : '只看中断计费'}
          </Button>
          <span className="text-[11px] text-[var(--fg-4)]">中断计费：任务已取消/失败，但上游已经开始运行，仍产生消耗。</span>
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[11.5px]">
            <thead className="bg-white/[0.03] text-[var(--fg-3)]">
              <tr>
                <th className="px-3 py-2 text-left font-medium">时间</th>
                {isAdmin ? <th className="px-3 py-2 text-left font-medium">账号</th> : null}
                <th className="px-3 py-2 text-left font-medium">项目</th>
                <th className="px-3 py-2 text-left font-medium">类型</th>
                <th className="px-3 py-2 text-left font-medium">章节 / 对象</th>
                <th className="px-3 py-2 text-right font-medium">消耗</th>
                <th className="px-3 py-2 text-left font-medium">任务状态</th>
                <th className="px-3 py-2 text-left font-medium">说明</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-t border-[var(--line)]">
                  <td className="whitespace-nowrap px-3 py-2 text-[var(--fg-4)]">{fmtTime(r.createdAt)}</td>
                  {isAdmin ? <td className="whitespace-nowrap px-3 py-2 text-[var(--fg-3)]">{userName(r.ownerId)}</td> : null}
                  <td className="max-w-[180px] truncate px-3 py-2 text-[var(--fg-2)]" title={r.projectName || r.projectId}>
                    {projectName(r.projectId, r.projectName)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{KIND_LABEL[r.kind] || r.kind}</td>
                  <td className="max-w-[200px] truncate px-3 py-2 text-[var(--fg-3)]" title={[r.chapter, r.subject].filter(Boolean).join(' · ')}>
                    {[r.chapter, r.subject].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--fg)]">{r.amount} {r.currency}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {r.jobStatus ? (
                      <Badge tone={r.jobStatus === 'done' ? 'success' : r.jobStatus === 'failed' || r.jobStatus === 'cancelled' || r.jobStatus === 'interrupted' ? 'danger' : 'neutral'}>
                        {STATUS_LABEL[r.jobStatus] || r.jobStatus}
                      </Badge>
                    ) : <span className="text-[var(--fg-4)]">—</span>}
                  </td>
                  <td className="max-w-[220px] px-3 py-2">
                    {r.note ? <Badge tone="danger">{r.note}</Badge> : <span className="text-[var(--fg-4)]">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading ? <div className="flex justify-center py-8"><Spinner /></div> : null}
        {!loading && !items.length ? <EmptyState icon={Receipt} title="暂无消费记录" description="生成、导出等产生费用后会出现在这里。" /> : null}
        {!loading && items.length < (data?.total || 0) ? (
          <div className="flex justify-center border-t border-[var(--line)] py-3">
            <Button variant="secondary" size="sm" loading={more} onClick={() => load(true)}>加载更多（{items.length}/{data.total}）</Button>
          </div>
        ) : null}
      </div>

      {data?.stats?.length ? (
        <div className="panel flex flex-wrap gap-2 p-3">
          {data.stats.map((s) => (
            <span key={s.kind + s.currency} className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-[11px] text-[var(--fg-3)]">
              {KIND_LABEL[s.kind] || s.kind}：{s.amount} {s.currency}（{s.count} 次）
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
