import { useState } from 'react';
import { KeyRound, Lock, UserRound } from 'lucide-react';
import { api } from '../lib/api.js';
import { setAuthToken } from '../lib/auth.js';
import { Button, Field, Input } from './ui.jsx';
import { Modal } from './overlays.jsx';

// dialog=true 时渲染为弹窗（按需登录）：进入 Studio 不再整页拦截，只有点到需要身份的操作才出现。
export default function LoginPage({ hasUsers, onAuthed, dialog = false, onClose, reason, title, description }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bootstrap = !hasUsers;

  async function submit(e) {
    e?.preventDefault();
    setError('');
    if (bootstrap && password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      const r = bootstrap
        ? await api.post('/api/auth/bootstrap', { username, password })
        : await api.post('/api/auth/login', { username, password });
      setAuthToken(r.token);
      onAuthed(r.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form onSubmit={submit} className={dialog ? 'flex w-full flex-col gap-4' : 'panel flex w-full max-w-[380px] flex-col gap-4 px-6 py-7'}>
      {dialog ? null : (
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[rgba(232,177,92,.35)] bg-[linear-gradient(145deg,rgba(232,177,92,.22),rgba(232,177,92,.05))] text-[var(--accent)]">
            {bootstrap ? <KeyRound size={19} /> : <Lock size={19} />}
          </span>
          <h1 className="m-0 text-[18px] font-semibold tracking-[-.01em] text-[var(--fg)]">
            {title || (bootstrap ? '创建管理员账号' : '登录无限创作')}
          </h1>
          <p className="m-0 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
            {description || (bootstrap ? '首次使用：创建后即可登录，项目数据只属于该账号。' : '登录后可创建项目、运行流程与查看成片。')}
          </p>
        </div>
      )}

      <Field label="用户名">
        <div className="relative">
          <UserRound size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--fg-3)]" />
          <Input
            autoFocus={!dialog}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="pl-9"
            placeholder="用户名"
            autoComplete="username"
          />
        </div>
      </Field>
      <Field label="密码" hint={bootstrap ? '至少 8 位' : undefined}>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码"
          autoComplete={bootstrap ? 'new-password' : 'current-password'}
        />
      </Field>
      {bootstrap ? (
        <Field label="确认密码">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再次输入密码" autoComplete="new-password" />
        </Field>
      ) : null}

      {error ? (
        <p className="m-0 rounded-lg border border-[color-mix(in_srgb,var(--danger)_28%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        size="md"
        loading={busy}
        disabled={busy || !username.trim() || password.length < (bootstrap ? 8 : 1)}
      >
        {bootstrap ? '创建并登录' : '登录'}
      </Button>
      <p className="m-0 text-center text-[10.5px] leading-relaxed text-[var(--fg-4)]">
        内容需符合规范：禁止露骨色情、血腥暴力、政治敏感、武器教学与宗教极端内容。
      </p>
    </form>
  );

  if (!dialog) {
    return <div className="flex min-h-screen items-center justify-center px-4 py-10">{form}</div>;
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose?.();
      }}
      title={title || (bootstrap ? '创建管理员账号' : '登录无限创作')}
      description={description || reason || (bootstrap ? '首次使用：创建后即可登录，项目数据只属于该账号。' : '登录后可创建项目、运行流程与查看成片。')}
      size="sm"
    >
      {form}
    </Modal>
  );
}
