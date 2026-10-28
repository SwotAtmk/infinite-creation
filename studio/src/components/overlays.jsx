import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronDown, X } from 'lucide-react';
import { Spinner } from './ui.jsx';

const MODAL_WIDTH = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
  '2xl': 'max-w-4xl',
  '5xl': 'max-w-6xl',
};

export function Modal({ open, onOpenChange, title, description, footer, children, size = 'md', className, bodyClassName, hideClose = false }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-[6px] data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          className={clsx(
            'fixed left-1/2 top-1/2 z-[210] flex max-h-[90vh] w-[calc(100vw-28px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
            'rounded-2xl border border-[var(--line-strong)] bg-[var(--panel)] shadow-[0_40px_120px_-30px_rgba(0,0,0,1)]',
            'data-[state=open]:animate-scale-in',
            MODAL_WIDTH[size] || MODAL_WIDTH.md,
            className,
          )}
        >
          {title || !hideClose ? (
            <header className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
              <div className="min-w-0">
                {title ? <DialogPrimitive.Title className="m-0 text-[15px] font-semibold text-[var(--fg)]">{title}</DialogPrimitive.Title> : null}
                {description ? <DialogPrimitive.Description className="mt-1 text-[12px] leading-relaxed text-[var(--fg-3)]">{description}</DialogPrimitive.Description> : null}
              </div>
              {!hideClose ? (
                <DialogPrimitive.Close
                  aria-label="关闭"
                  className="-mr-1 -mt-1 rounded-lg p-1.5 text-[var(--fg-3)] transition-colors hover:bg-white/[0.06] hover:text-[var(--fg)]"
                >
                  <X size={16} />
                </DialogPrimitive.Close>
              ) : null}
            </header>
          ) : null}
          <div className={clsx('min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>{children}</div>
          {footer ? <footer className="flex items-center justify-end gap-2 border-t border-[var(--line)] bg-black/15 px-5 py-3.5">{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Drawer({ open, onOpenChange, title, description, footer, children, width = 520, bodyClassName, headerRight, scrollHint = '下面还有内容' }) {
  const bodyRef = useRef(null);
  const [moreBelow, setMoreBelow] = useState(false);

  const updateMore = () => {
    const el = bodyRef.current;
    if (!el) return;
    setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 24);
  };

  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el) return;
    const t = setTimeout(updateMore, 80);
    const ro = new ResizeObserver(updateMore);
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [open]);

  const scrollDown = () => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollBy({ top: Math.max(180, Math.round(el.clientHeight * 0.65)), behavior: 'smooth' });
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[200] bg-black/55 backdrop-blur-[3px] data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          style={{ width }}
          className={clsx(
            'fixed right-0 top-0 z-[210] flex h-full max-w-[100vw] flex-col overflow-hidden border-l border-[var(--line-strong)]',
            'bg-[var(--panel)] shadow-[-40px_0_100px_-30px_rgba(0,0,0,.95)]',
            'data-[state=open]:animate-slide-in',
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="m-0 text-[15px] font-semibold text-[var(--fg)]">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-[12px] leading-relaxed text-[var(--fg-3)]">{description}</DialogPrimitive.Description>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              {headerRight}
              <DialogPrimitive.Close
                aria-label="关闭"
                className="rounded-lg p-1.5 text-[var(--fg-3)] transition-colors hover:bg-white/[0.06] hover:text-[var(--fg)]"
              >
                <X size={16} />
              </DialogPrimitive.Close>
            </div>
          </header>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div ref={bodyRef} onScroll={updateMore} className={clsx('min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>{children}</div>
            {moreBelow ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-[var(--panel)] via-[var(--panel)]/92 to-transparent pb-2 pt-10">
                <button
                  type="button"
                  onClick={scrollDown}
                  className="pointer-events-auto flex items-center gap-1 rounded-full border border-[var(--line-strong)] bg-[var(--panel-2)]/95 px-2.5 py-1 text-[10.5px] text-[var(--fg-2)] shadow-[0_8px_24px_-12px_rgba(0,0,0,.9)] transition-colors hover:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] hover:text-[var(--fg)]"
                >
                  <ChevronDown size={12} className="animate-bounce" />
                  {scrollHint}
                </button>
              </div>
            ) : null}
          </div>
          {footer ? <footer className="flex items-center justify-end gap-2 border-t border-[var(--line)] bg-black/15 px-5 py-3.5">{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// 表单分节：标题 + 说明 + 内容，统一间距，避免每个弹窗各写一套
export function FormSection({ index, title, description, children, className }) {
  return (
    <section className={clsx('flex flex-col gap-3', className)}>
      <div className="flex items-baseline gap-2.5">
        {index ? <span className="font-mono text-[10px] tracking-[.12em] text-[var(--accent)]/80">{index}</span> : null}
        <h3 className="m-0 text-[12.5px] font-semibold text-[var(--fg)]">{title}</h3>
        {description ? <span className="text-[11.5px] text-[var(--fg-3)]">{description}</span> : null}
      </div>
      {children}
    </section>
  );
}

// 全屏阻断层：删除 / 上传 / 提交生成这类会造成重复写入的操作
export function BusyOverlay({ show, text }) {
  if (!show) return null;
  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/55 backdrop-blur-[3px]">
      <div className="flex items-center gap-3 rounded-xl border border-[var(--line-strong)] bg-[var(--panel-2)] px-5 py-3.5 shadow-[0_30px_80px_-24px_rgba(0,0,0,1)]">
        <Spinner size={16} />
        <span className="text-[12.5px] text-[var(--fg-2)]">{text || '处理中…'}</span>
      </div>
    </div>
  );
}
