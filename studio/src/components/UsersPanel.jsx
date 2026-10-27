import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, ShieldCheck, UserRound } from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button, Checkbox, Field, Input, Select } from './ui.jsx';
import { useToast } from './toast.jsx';

const ROLE_ITEMS = [
  { value: 'creator', label: '创作者' },
  { value: 'viewer', label: '访客（只读）' },
  { value: 'admin', label: '管理员' },
];
const ROLE_LABEL = { admin: '管理员', creator: '创作者', viewer: '访客' };
const PERM_ITEMS = [
  { key: 'create_project', label: '建项目' },
  { key: 'edit', label: '编辑' },
  { key: 'generate', label: '生成' },
  { key: 'export', label: '导出' },
];

function effPerms(u, key) {
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (u.permissions && typeof u.permissions[key] === 'boolean') return u.permissions[key];
  return u.role !== 'viewer';
}

export default function UsersPanel() {
  const toast = useToast();
  const [me, setMe] = useState(null);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', role: 'creator' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const m = await api.get('/api/auth/me');
      setMe(m);
      if (m.authEnabled && m.user?.role === 'admin') {
        const r = await api.get('/api/auth/users');
        setUsers(r.users || []);
      }
    } catch (e) {
      toast.error(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!me) return <span className="text-[11px] text-[var(--fg-4)]">账号信息加载中…</span>;
  if (!me.authEnabled) {
    return (
      <p className="m-0 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
        当前为本地模式（IC_AUTH 未开启），不需要登录。对外服务请用 <code className="font-mono">start-studio.bat</code> 启动，会自动开启登录。
      </p>
    );
  }
  if (me.user?.role !== 'admin') return <span className="text-[11px] text-[var(--fg-4)]">需要管理员权限</span>;

  async function create() {
    setBusy(true);
    try {
      await api.post('/api/auth/users', form);
      toast.success('已创建账号：' + form.username);
      setForm({ username: '', password: '', role: 'creator' });
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(u, body, label) {
    try {
      await api.patch('/api/auth/users/' + encodeURIComponent(u.id), body);
      toast.success(label);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  }

  function togglePerm(u, key) {
    if (u.role === 'admin') return;
    const next = {};
    for (const p of PERM_ITEMS) next[p.key] = p.key === key ? !effPerms(u, p.key) : effPerms(u, p.key);
    patch(u, { perms: next }, '已更新权限');
  }

  async function resetPassword(u) {
    const password = await toast.prompt('为「' + u.username + '」设置新密码（至少 8 位）', { placeholder: '新密码' });
    if (!password) return;
    if (password.length < 8) {
      toast.error('密码至少 8 位');
      return;
    }
    patch(u, { password }, '已重置密码');
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col divide-y divide-[var(--line)] rounded-xl border border-[var(--line)] bg-white/[0.015]">
        {users.map((u) => (
          <div key={u.id} className="flex flex-col gap-2 px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)]">
                {u.role === 'admin' ? <ShieldCheck size={13} /> : <UserRound size={13} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] font-medium text-[var(--fg-2)]">{u.username}</span>
                  {u.id === me.user?.id ? <Badge tone="accent">当前账号</Badge> : null}
                  <Badge tone={u.role === 'admin' ? 'info' : 'neutral'}>{ROLE_LABEL[u.role] || u.role}</Badge>
                  {u.source === 'sso' ? <Badge tone="neutral">SSO</Badge> : null}
                  {u.disabled ? <Badge tone="danger">已停用</Badge> : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Select
                  value={u.role}
                  onChange={(v) => patch(u, { role: v }, '已更新角色')}
                  items={ROLE_ITEMS}
                  size="sm"
                  disabled={u.id === me.user?.id}
                />
                <Button size="sm" variant="ghost" onClick={() => resetPassword(u)}>
                  <KeyRound size={12} /> 重置密码
                </Button>
                {u.id !== me.user?.id ? (
                  <Button
                    size="sm"
                    variant={u.disabled ? 'secondary' : 'danger'}
                    onClick={() => patch(u, { disabled: !u.disabled }, u.disabled ? '已启用账号' : '已停用账号')}
                  >
                    {u.disabled ? '启用' : '停用'}
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 pl-10">
              <span className="text-[10.5px] text-[var(--fg-4)]">功能权限</span>
              {PERM_ITEMS.map((p) => (
                <Checkbox
                  key={p.key}
                  checked={effPerms(u, p.key)}
                  onChange={() => togglePerm(u, p.key)}
                  disabled={u.role === 'admin'}
                  label={p.label}
                />
              ))}
              {u.role === 'admin' ? <span className="text-[10.5px] text-[var(--fg-4)]">管理员默认拥有全部权限</span> : null}
            </div>
          </div>
        ))}
        {!users.length ? <p className="m-0 px-3.5 py-4 text-[11.5px] text-[var(--fg-4)]">还没有其他账号</p> : null}
      </div>

      <div className="grid gap-2.5 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3 sm:grid-cols-[1fr_1fr_140px_auto] sm:items-end">
        <Field label="用户名">
          <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="例如 user01" className="h-9" />
        </Field>
        <Field label="初始密码">
          <Input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="至少 8 位"
            className="h-9"
          />
        </Field>
        <Field label="角色">
          <Select value={form.role} onChange={(v) => setForm({ ...form, role: v })} items={ROLE_ITEMS} size="sm" />
        </Field>
        <Button variant="primary" size="md" loading={busy} disabled={busy || !form.username.trim() || form.password.length < 8} onClick={create}>
          <Plus size={13} /> 创建账号
        </Button>
      </div>

      <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
        独立部署不开放自助注册，账号由管理员在此创建。角色决定默认权限，可再逐个开关覆盖；管理员始终拥有全部权限。
        停用账号会立即让其已登录的会话失效。
      </p>
    </div>
  );
}
