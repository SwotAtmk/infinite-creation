import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, Github, Lock, LogIn, LogOut, Receipt, Settings2, ShieldCheck, Sparkles, UserRound, Wallet } from 'lucide-react';
import { Button } from './ui.jsx';
import { Modal } from './overlays.jsx';
import { authHeaders } from '../lib/auth.js';

const COST_KIND = {
  llm: 'LLM 创作', 'llm-chapter': 'LLM 创作', 'llm-rewrite': 'LLM 改写',
  image: '资产图', t2i: '资产图', i2i: '资产图',
  tts: '音色', voice: '音色',
  r2v: '分镜视频', video: '分镜视频',
  music: '背景音乐', export: '合成 / 导出', assemble: '合成 / 导出',
};

export default function TopBar({ onHome, onSettings, onAdmin, serverInfo, auth, features = {}, adminAllowed = false, canAdmin = true, showSettings = true, onLogout, onLogin }) {
  const online = serverInfo?.online !== false;
  const publicMode = !!serverInfo?.publicMode;
  const user = auth?.authEnabled ? auth.user : null;
  // 免登录模式不在首页暴露账号/管理入口：管理员统一从独立路由 /admin 登录进入。
  const account = user;
  const [wallet, setWallet] = useState(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);
  useEffect(() => {
    if (!user) { setWallet(null); return; }
    let alive = true;
    const load = () =>
      fetch('/api/billing/me', { headers: authHeaders() })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (alive && j && j.enabled) setWallet(j); else if (alive) setWallet(null); })
        .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [user?.id]);
  return (
    <>
    <header className="sticky top-0 z-[120] border-b border-[var(--line)] bg-[rgba(10,11,13,.72)] backdrop-blur-xl">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(232,177,92,.35),transparent)]" />
      <div className="mx-auto flex h-16 max-w-[1360px] items-center justify-between gap-4 px-5">
        <button type="button" onClick={onHome} className="group flex items-center gap-3">
          <span className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-[11px] border border-[rgba(232,177,92,.35)] bg-[linear-gradient(145deg,rgba(232,177,92,.22),rgba(232,177,92,.05))] text-[var(--accent)] shadow-[inset_0_1px_0_rgba(255,255,255,.14),0_8px_24px_-12px_rgba(232,177,92,.5)] transition-transform duration-200 group-hover:scale-[1.03]">
            <Sparkles size={17} />
          </span>
          <span className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-[-.01em] text-[var(--fg)]">无限创作</span>
            <span className="rounded border border-[var(--line-strong)] px-1.5 py-0.5 font-mono text-[9.5px] tracking-[.16em] text-[var(--fg-3)]">STUDIO</span>
          </span>
        </button>

        <div className="flex items-center gap-2">
          <span
            className="hidden items-center gap-2 rounded-full border border-[var(--line)] bg-white/[0.025] px-2.5 py-1 text-[11px] text-[var(--fg-3)] sm:inline-flex"
            title={online ? (publicMode ? '云端服务在线' : 'Studio 后端在线（4610）') : '服务不可达'}
          >
            <span className={clsx('h-1.5 w-1.5 rounded-full', online ? 'bg-[var(--success)]' : 'bg-[var(--danger)]', online && 'animate-pulse-soft')} />
            {online ? (publicMode ? '服务正常' : '主服务在线') : '服务不可用'}
          </span>
          {serverInfo?.render ? (
            <span
              className="hidden h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 text-[11px] text-[var(--fg-3)] sm:inline-flex"
              title={'当前执行端：' + serverInfo.render.label + '；有效并发 ' + serverInfo.render.concurrency}
            >
              {serverInfo.render.label} · 并发 {serverInfo.render.concurrency}
            </span>
          ) : null}
          {publicMode ? (
            <span className="hidden h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 text-[11px] text-[var(--fg-3)] sm:inline-flex">
              <Lock size={12} />
              云端托管
            </span>
          ) : null}
          {auth?.authEnabled && !user && onLogin && features?.buttons?.login !== false ? (
            <Button variant="secondary" size="sm" onClick={() => onLogin('登录后可创建项目、运行流程与查看成片')}>
              <LogIn size={14} />
              登录
            </Button>
          ) : null}
          {account ? (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-white/[0.02] px-2 text-[11px] text-[var(--fg-2)] transition-colors hover:border-[var(--line-strong)] hover:bg-white/[0.04]"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <UserRound size={12} className="text-[var(--fg-3)]" />
                <span className="max-w-[120px] truncate">{account.username}</span>
                {account.role === 'admin' ? <span className="text-[9.5px] text-[var(--accent)]">管理员</span> : null}
                <ChevronDown size={12} className={clsx('text-[var(--fg-3)] transition-transform', menuOpen && 'rotate-180')} />
              </button>

              {menuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-[200] mt-2 w-60 overflow-hidden rounded-xl border border-[var(--line-strong)] bg-[#0f1013] p-1.5 shadow-[0_18px_60px_-12px_rgba(0,0,0,.9)]"
                >
                  <div className="px-2.5 pb-2 pt-1.5">
                    <p className="m-0 truncate text-[12.5px] font-medium text-[var(--fg)]">{account.username}</p>
                    <p className="m-0 mt-0.5 text-[10.5px] text-[var(--fg-4)]">
                      {account.role === 'admin' ? '管理员' : account.role === 'viewer' ? '只读账号' : '创作者'}
                    </p>
                  </div>

                  {user && wallet ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] text-[var(--fg-2)] transition-colors hover:bg-white/[0.05] hover:text-[var(--fg)]"
                      onClick={() => { setMenuOpen(false); setWalletOpen(true); }}
                    >
                      <Wallet size={14} className="text-[var(--fg-3)]" />
                      <span>可用余额</span>
                      <span className="ml-auto font-mono text-[11.5px] text-[var(--accent)]">{wallet.balance} {wallet.currency}</span>
                    </button>
                  ) : null}

                  {user ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] text-[var(--fg-2)] transition-colors hover:bg-white/[0.05] hover:text-[var(--fg)]"
                      onClick={() => { setMenuOpen(false); window.location.assign('/usage'); }}
                    >
                      <Receipt size={14} className="text-[var(--fg-3)]" />
                      消费记录
                    </button>
                  ) : null}

                  {!publicMode && canAdmin && adminAllowed && onAdmin ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] text-[var(--fg-2)] transition-colors hover:bg-white/[0.05] hover:text-[var(--fg)]"
                      onClick={() => { setMenuOpen(false); onAdmin(); }}
                    >
                      <ShieldCheck size={14} className="text-[var(--fg-3)]" />
                      管理后台
                    </button>
                  ) : null}

                  {!publicMode && canAdmin && adminAllowed && showSettings ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] text-[var(--fg-2)] transition-colors hover:bg-white/[0.05] hover:text-[var(--fg)]"
                      onClick={() => { setMenuOpen(false); onSettings(); }}
                    >
                      <Settings2 size={14} className="text-[var(--fg-3)]" />
                      系统设置
                    </button>
                  ) : null}

                  {!publicMode && features?.buttons?.github !== false ? (
                    <a
                      role="menuitem"
                      href="https://github.com/SwotAtmk/infinite-creation"
                      target="_blank"
                      rel="noreferrer"
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] text-[var(--fg-2)] transition-colors hover:bg-white/[0.05] hover:text-[var(--fg)]"
                      onClick={() => setMenuOpen(false)}
                    >
                      <Github size={14} className="text-[var(--fg-3)]" />
                      GitHub 仓库
                    </a>
                  ) : null}

                  {user && onLogout ? (
                    <>
                      <div className="my-1 h-px bg-[var(--line)]" />
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] text-[var(--danger)] transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_8%,transparent)]"
                        onClick={() => { setMenuOpen(false); onLogout(); }}
                      >
                        <LogOut size={14} />
                        退出登录
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </header>
    <Modal
      open={walletOpen}
      onOpenChange={setWalletOpen}
      title="我的积分"
      description="余额、在途预授权与最近消耗"
      size="md"
    >
      {wallet ? (
        <div className="flex flex-col gap-4 text-[12px]">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-[var(--line)] px-3 py-2">
              <p className="m-0 text-[10.5px] text-[var(--fg-4)]">可用余额</p>
              <p className="m-0 mt-1 font-mono text-[15px] text-[var(--fg)]">{wallet.balance} {wallet.currency}</p>
            </div>
            <div className="rounded-lg border border-[var(--line)] px-3 py-2">
              <p className="m-0 text-[10.5px] text-[var(--fg-4)]">在途</p>
              <p className="m-0 mt-1 font-mono text-[15px] text-[var(--fg-2)]">{wallet.held}</p>
            </div>
            <div className="rounded-lg border border-[var(--line)] px-3 py-2">
              <p className="m-0 text-[10.5px] text-[var(--fg-4)]">今日已用</p>
              <p className="m-0 mt-1 font-mono text-[15px] text-[var(--fg-2)]">{wallet.todayUsed}</p>
            </div>
          </div>
          <p className="m-0 text-[11px] text-[var(--fg-3)]">本月已用 {wallet.monthUsed} {wallet.currency}</p>
          {wallet.projects?.length ? (
            <div className="flex flex-col gap-1">
              <p className="m-0 text-[11px] font-medium text-[var(--fg-2)]">按项目</p>
              {wallet.projects.map((p) => (
                <div key={p.projectId} className="flex items-center justify-between gap-2 text-[11.5px] text-[var(--fg-3)]">
                  <span className="truncate">{p.name || p.projectId}</span>
                  <span className="shrink-0 font-mono">{p.amount} {p.currency}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <p className="m-0 text-[11px] font-medium text-[var(--fg-2)]">最近消耗</p>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--line)]">
              {wallet.recent?.length ? wallet.recent.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-3 py-2 last:border-b-0">
                  <span className="shrink-0 text-[11.5px] text-[var(--fg-2)]">{COST_KIND[r.kind] || r.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--fg-4)]">{r.chapter || r.subject || '—'}</span>
                  <span className="shrink-0 font-mono text-[11.5px] text-[var(--fg)]">{r.amount} {r.currency}</span>
                </div>
              )) : <p className="m-0 px-3 py-3 text-[11px] text-[var(--fg-4)]">暂无消耗</p>}
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={() => { setWalletOpen(false); window.location.assign('/usage'); }}>
              查看完整消费记录
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
    </>
  );
}
