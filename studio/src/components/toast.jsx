import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { Modal } from './overlays.jsx';
import { Button, Input } from './ui.jsx';

const ToastCtx = createContext(null);

export function useToast() {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('useToast 需在 <ToastProvider> 内使用');
  return v;
}

let seq = 0;

const KIND = {
  info: { icon: Info, color: 'var(--info)', label: '提示' },
  success: { icon: CheckCircle2, color: 'var(--success)', label: '成功' },
  warn: { icon: AlertTriangle, color: 'var(--accent)', label: '注意' },
  error: { icon: XCircle, color: 'var(--danger)', label: '错误' },
};

// 默认自动收回时间：错误留久一点，成功/提示很快消失。
// 带操作按钮的通知默认不自动收回（避免用户还没点到按钮就消失）；
// 需要常驻可以显式传 ttl: 0。
const DEFAULT_TTL = { info: 4000, success: 3500, warn: 5000, error: 8000 };

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [promptVal, setPromptVal] = useState('');
  const dialogRef = useRef(null);

  const remove = useCallback((id) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const ask = useCallback((d) => {
    dialogRef.current = d;
    if (d.mode === 'prompt') setPromptVal(d.defaultValue || '');
    setDialog({
      mode: d.mode,
      message: d.message,
      danger: !!d.danger,
      confirmLabel: d.confirmLabel,
      cancelLabel: d.cancelLabel,
      placeholder: d.placeholder || '',
    });
  }, []);

  const answer = useCallback((v) => {
    const d = dialogRef.current;
    dialogRef.current = null;
    setDialog(null);
    if (d) d.resolve(v);
  }, []);

  const confirm = useCallback(
    (message, opts = {}) =>
      new Promise((resolve) => {
        ask({
          mode: 'confirm',
          message,
          danger: !!opts.danger,
          confirmLabel: opts.confirmLabel || '确定',
          cancelLabel: opts.cancelLabel || '取消',
          resolve,
        });
      }),
    [ask],
  );

  const prompt = useCallback(
    (message, opts = {}) =>
      new Promise((resolve) => {
        ask({
          mode: 'prompt',
          message,
          placeholder: opts.placeholder || '',
          defaultValue: opts.defaultValue || '',
          confirmLabel: opts.confirmLabel || '确定',
          cancelLabel: opts.cancelLabel || '取消',
          resolve,
        });
      }),
    [ask],
  );

  const open = useCallback((opt) => {
    const id = ++seq;
    const kind = opt.kind || 'info';
    const buttons = Array.isArray(opt.buttons) ? opt.buttons : [];
    const ttl = opt.ttl != null ? Number(opt.ttl) : (buttons.length ? 0 : (DEFAULT_TTL[kind] ?? 4000));
    setItems((list) => [
      ...list.slice(-4),
      {
        id,
        kind,
        message: String(opt.message == null ? '' : opt.message),
        buttons,
        ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : 0,
      },
    ]);
    return id;
  }, []);

  const api = useMemo(
    () => ({
      open,
      info: (message, opts = {}) => open({ ...opts, kind: 'info', message }),
      success: (message, opts = {}) => open({ ...opts, kind: 'success', message }),
      warn: (message, opts = {}) => open({ ...opts, kind: 'warn', message }),
      error: (message, opts = {}) => open({ ...opts, kind: 'error', message }),
      confirm,
      prompt,
      dismiss: remove,
    }),
    [open, confirm, prompt, remove],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}

      <div className="pointer-events-none fixed bottom-20 right-5 z-[300] flex max-w-[min(440px,92vw)] flex-col items-end gap-2.5">
        {items.map((t) => (
          <ToastItem key={t.id} t={t} onClose={remove} />
        ))}
      </div>

      <Modal
        open={!!dialog}
        onOpenChange={(o) => {
          if (!o) answer(dialog.mode === 'prompt' ? null : false);
        }}
        size="sm"
        hideClose
        bodyClassName="px-5 pb-1 pt-5"
        footer={
          dialog ? (
            <>
              <Button variant="secondary" size="md" onClick={() => answer(dialog.mode === 'prompt' ? null : false)}>
                {dialog.cancelLabel}
              </Button>
              <Button
                variant={dialog.danger ? 'dangerSolid' : 'primary'}
                size="md"
                onClick={() => {
                  if (dialog.mode === 'prompt') {
                    const v = promptVal.trim();
                    answer(v || null);
                  } else answer(true);
                }}
              >
                {dialog.confirmLabel}
              </Button>
            </>
          ) : null
        }
      >
        {dialog ? (
          <div className="flex flex-col gap-3">
            <p className={clsx('m-0 whitespace-pre-line text-[13.5px] leading-relaxed', dialog.danger ? 'text-[var(--fg)]' : 'text-[var(--fg-2)]')}>
              {dialog.message}
            </p>
            {dialog.mode === 'prompt' ? (
              <PromptInput value={promptVal} onChange={setPromptVal} placeholder={dialog.placeholder} onSubmit={() => answer(promptVal.trim() || null)} />
            ) : null}
          </div>
        ) : null}
      </Modal>
    </ToastCtx.Provider>
  );
}

function ToastItem({ t, onClose }) {
  const meta = KIND[t.kind] || KIND.info;
  const Icon = meta.icon;
  const [paused, setPaused] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!t.ttl || paused) return undefined;
    timerRef.current = setTimeout(() => onClose(t.id), t.ttl);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [t.id, t.ttl, paused, onClose]);

  return (
    <div
      role={t.kind === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto flex w-full animate-slide-in items-start gap-2.5 rounded-xl border border-[var(--line-strong)] bg-[var(--panel-2)]/95 p-3 text-[12.5px] shadow-[0_24px_60px_-20px_rgba(0,0,0,.95)] backdrop-blur-md"
      style={{ borderLeft: '2px solid ' + meta.color }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <Icon size={15} style={{ color: meta.color }} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-line break-words leading-relaxed text-[var(--fg-2)]">{t.message}</span>
      {t.buttons.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1">
          {t.buttons.map((b, i) => (
            <Button
              key={i}
              size="xs"
              variant={b.tone === 'primary' ? 'primary' : b.tone === 'danger' ? 'danger' : 'secondary'}
              onClick={() => {
                b.onClick?.();
                onClose(t.id);
              }}
            >
              {b.label}
            </Button>
          ))}
        </span>
      ) : null}
      <button
        type="button"
        aria-label="关闭提示"
        onClick={() => onClose(t.id)}
        className="shrink-0 rounded p-0.5 text-[var(--fg-3)] transition-colors hover:text-[var(--fg)]"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function PromptInput({ value, onChange, placeholder, onSubmit }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <Input
      ref={ref}
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSubmit();
      }}
    />
  );
}
