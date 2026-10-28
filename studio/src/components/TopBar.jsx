import clsx from 'clsx';
import { Github, Settings2, Sparkles } from 'lucide-react';
import { Button } from './ui.jsx';

export default function TopBar({ onHome, onSettings, serverInfo, features = {}, showSettings = true }) {
  const online = serverInfo?.online !== false;
  const publicMode = !!serverInfo?.publicMode;
  return (
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
              云端托管
            </span>
          ) : null}
          {onSettings && showSettings ? (
            <Button variant="secondary" size="sm" onClick={onSettings}>
              <Settings2 size={13} />
              系统设置
            </Button>
          ) : null}
          {!publicMode && features?.buttons?.github !== false ? (
            <a
              href="https://github.com/SwotAtmk/infinite-creation"
              target="_blank"
              rel="noreferrer"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--line)] text-[var(--fg-3)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--fg)]"
              title="GitHub 仓库"
            >
              <Github size={14} />
            </a>
          ) : null}
        </div>
      </div>
    </header>
  );
}
