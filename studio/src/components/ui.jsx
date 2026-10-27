import { forwardRef } from 'react';
import clsx from 'clsx';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Check, ChevronDown, Loader2, Search, X } from 'lucide-react';

// ---------------- Button ----------------

const BUTTON_VARIANT = {
  primary:
    'text-[var(--accent-ink)] bg-[linear-gradient(180deg,var(--accent-2),var(--accent))] shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_10px_26px_-14px_rgba(232,177,92,.55)] hover:brightness-[1.05] active:brightness-95',
  secondary:
    'text-[var(--fg)] bg-white/[0.04] border border-[var(--line)] hover:bg-white/[0.07] hover:border-[var(--line-strong)] active:bg-white/[0.05]',
  ghost: 'text-[var(--fg-2)] hover:text-[var(--fg)] hover:bg-white/[0.055] active:bg-white/[0.04]',
  danger:
    'text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_13%,transparent)] border border-[color-mix(in_srgb,var(--danger)_28%,transparent)] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)]',
  dangerSolid: 'text-white bg-[var(--danger)] hover:brightness-105',
  success:
    'text-[var(--success)] bg-[color-mix(in_srgb,var(--success)_12%,transparent)] border border-[color-mix(in_srgb,var(--success)_26%,transparent)] hover:bg-[color-mix(in_srgb,var(--success)_18%,transparent)]',
};

const BUTTON_SIZE = {
  xs: 'h-7 px-2.5 text-[12px] gap-1.5 rounded-lg',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-[13.5px] gap-2 rounded-xl',
  lg: 'h-11 px-5 text-sm gap-2 rounded-xl',
  icon: 'h-9 w-9 rounded-lg',
  iconSm: 'h-7 w-7 rounded-md',
};

export const Button = forwardRef(function Button(
  { variant = 'secondary', size = 'sm', loading = false, disabled, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        'relative inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-all duration-150',
        'disabled:cursor-not-allowed disabled:opacity-45',
        'active:scale-[.975] disabled:active:scale-100',
        BUTTON_VARIANT[variant] || BUTTON_VARIANT.secondary,
        BUTTON_SIZE[size] || BUTTON_SIZE.sm,
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'xs' ? 12 : 14} className="animate-spin" /> : null}
      {children}
    </button>
  );
});

// ---------------- Field / Input ----------------

export function Field({ label, hint, error, required, htmlFor, children, className, action }) {
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      {label ? (
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-[var(--fg-2)]">
            {label}
            {required ? <span className="ml-0.5 text-[var(--accent)]">*</span> : null}
          </label>
          {action}
        </div>
      ) : null}
      {children}
      {error ? (
        <p className="m-0 text-[11.5px] leading-relaxed text-[var(--danger)]">{error}</p>
      ) : hint ? (
        <p className="m-0 text-[11.5px] leading-relaxed text-[var(--fg-3)]">{hint}</p>
      ) : null}
    </div>
  );
}

const inputBase =
  'w-full rounded-xl border border-[var(--line)] bg-white/[0.035] text-[13.5px] text-[var(--fg)] placeholder:text-[var(--fg-4)] ' +
  'transition-all duration-150 hover:border-[var(--line-strong)] ' +
  'focus:border-[color-mix(in_srgb,var(--accent)_55%,transparent)] focus:bg-white/[0.05] focus:outline-none ' +
  'focus:shadow-[0_0_0_3px_rgba(232,177,92,.12)] disabled:opacity-50';

export const Input = forwardRef(function Input({ className, invalid, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={clsx(inputBase, 'h-10 px-3.5', invalid && 'border-[color-mix(in_srgb,var(--danger)_55%,transparent)]', className)}
      {...rest}
    />
  );
});

export const Textarea = forwardRef(function Textarea({ className, invalid, rows = 4, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={clsx(inputBase, 'resize-y px-3.5 py-2.5 leading-relaxed', invalid && 'border-[color-mix(in_srgb,var(--danger)_55%,transparent)]', className)}
      {...rest}
    />
  );
});

export function SearchInput({ value, onChange, placeholder = '搜索…', className }) {
  return (
    <div className={clsx('relative', className)}>
      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--fg-3)]" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-9 pl-9 pr-8 text-[13px]" />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="清空搜索"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--fg-3)] hover:text-[var(--fg)]"
        >
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
}

// ---------------- Select ----------------

const SELECT_NONE = '__studio_none__';

export function Select({ value, onChange, items, placeholder = '请选择', disabled, className, size = 'md' }) {
  const normalized = items.map((it) => ({ ...it, value: String(it.value ?? '') }));
  const internal = value == null || value === '' ? SELECT_NONE : String(value);
  const selected = normalized.find((it) => (it.value === '' ? SELECT_NONE : it.value) === internal) || null;
  return (
    <div className={clsx('relative min-w-0', className)}>
      <SelectPrimitive.Root value={internal} onValueChange={(v) => onChange(v === SELECT_NONE ? '' : v)} disabled={disabled}>
        <SelectPrimitive.Trigger
          className={clsx(
            inputBase,
            'flex w-full items-center justify-between gap-2 text-left',
            size === 'sm' ? 'h-9 px-3 text-[13px]' : 'h-10 px-3.5',
            'data-[placeholder]:text-[var(--fg-4)]',
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.icon ? <span className="shrink-0 text-[var(--fg-3)]">{selected.icon}</span> : null}
            <span className={clsx('truncate', !selected && 'text-[var(--fg-4)]')}>{selected ? selected.label : placeholder}</span>
          </span>
          <ChevronDown size={14} className="shrink-0 text-[var(--fg-3)]" />
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={6}
            className="z-[260] max-h-[320px] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-[var(--line-strong)] bg-[var(--panel-2)] shadow-[0_24px_60px_-20px_rgba(0,0,0,.95)]"
          >
            <SelectPrimitive.Viewport className="p-1.5">
              {normalized.map((it) => (
                <SelectPrimitive.Item
                  key={it.value || SELECT_NONE}
                  value={it.value === '' ? SELECT_NONE : it.value}
                  className="relative flex cursor-pointer select-none items-center rounded-lg py-2 pl-3 pr-8 text-[13px] text-[var(--fg-2)] outline-none data-[highlighted]:bg-white/[0.07] data-[highlighted]:text-[var(--fg)] data-[state=checked]:text-[var(--fg)]"
                >
                  {it.icon ? <span className="mr-2 shrink-0 text-[var(--fg-3)]">{it.icon}</span> : null}
                  <SelectPrimitive.ItemText>{it.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-2.5">
                    <Check size={13} className="text-[var(--accent)]" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  );
}

// ---------------- Switch / Checkbox ----------------

export function Switch({ checked, onChange, label, hint, disabled, className }) {
  return (
    <label className={clsx('flex cursor-pointer items-start gap-3', disabled && 'cursor-not-allowed opacity-50', className)}>
      <SwitchPrimitive.Root
        checked={!!checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full border border-[var(--line-strong)] bg-white/[0.06] transition-colors data-[state=checked]:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] data-[state=checked]:bg-[color-mix(in_srgb,var(--accent)_28%,transparent)]"
      >
        <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-[3px] rounded-full bg-[var(--fg-2)] shadow transition-transform duration-200 data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-[var(--accent)]" />
      </SwitchPrimitive.Root>
      {label ? (
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium text-[var(--fg)]">{label}</span>
          {hint ? <span className="text-[11.5px] leading-relaxed text-[var(--fg-3)]">{hint}</span> : null}
        </span>
      ) : null}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, disabled, className, indeterminate }) {
  return (
    <label className={clsx('flex cursor-pointer items-center gap-2.5', disabled && 'cursor-not-allowed opacity-50', className)}>
      <CheckboxPrimitive.Root
        checked={indeterminate ? 'indeterminate' : !!checked}
        onCheckedChange={(v) => onChange(v === true)}
        disabled={disabled}
        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border border-[var(--line-strong)] bg-white/[0.04] transition-colors data-[state=checked]:border-[var(--accent)] data-[state=checked]:bg-[var(--accent)] data-[state=indeterminate]:border-[var(--accent)] data-[state=indeterminate]:bg-[var(--accent)]"
      >
        <CheckboxPrimitive.Indicator>
          {indeterminate ? (
            <span className="block h-[2px] w-2.5 rounded bg-[var(--accent-ink)]" />
          ) : (
            <Check size={13} strokeWidth={3} className="text-[var(--accent-ink)]" />
          )}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {label ? <span className="text-[13px] text-[var(--fg-2)]">{label}</span> : null}
    </label>
  );
}

// ---------------- Display ----------------

const TONE = {
  neutral: 'text-[var(--fg-3)] border-[var(--line)] bg-white/[0.03]',
  accent: 'text-[var(--accent)] border-[color-mix(in_srgb,var(--accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]',
  success: 'text-[var(--success)] border-[color-mix(in_srgb,var(--success)_26%,transparent)] bg-[color-mix(in_srgb,var(--success)_9%,transparent)]',
  danger: 'text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_28%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]',
  info: 'text-[var(--info)] border-[color-mix(in_srgb,var(--info)_26%,transparent)] bg-[color-mix(in_srgb,var(--info)_9%,transparent)]',
};

const DOT = {
  neutral: 'bg-[var(--fg-3)]',
  accent: 'bg-[var(--accent)]',
  success: 'bg-[var(--success)]',
  danger: 'bg-[var(--danger)]',
  info: 'bg-[var(--info)]',
};

export function Badge({ children, tone = 'neutral', dot = false, className }) {
  return (
    <span
      className={clsx(
        'inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium leading-none',
        TONE[tone] || TONE.neutral,
        className,
      )}
    >
      {dot ? <span className={clsx('h-1.5 w-1.5 rounded-full', DOT[tone] || DOT.neutral, tone === 'accent' && 'animate-pulse-soft')} /> : null}
      {children}
    </span>
  );
}

export function StatusPill({ status, children, className }) {
  const tone = status === 'done' ? 'success' : status === 'failed' ? 'danger' : ['running', 'generating'].includes(status) ? 'accent' : status === 'queued' ? 'info' : 'neutral';
  return (
    <Badge tone={tone} dot className={className}>
      {children ?? status}
    </Badge>
  );
}

export function Progress({ value = 0, tone = 'accent', className, height = 4 }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className={clsx('w-full overflow-hidden rounded-full bg-white/[0.06]', className)} style={{ height }}>
      <div
        className={clsx(
          'h-full rounded-full transition-[width] duration-500',
          tone === 'success' && 'bg-[var(--success)]',
          tone === 'danger' && 'bg-[var(--danger)]',
          tone === 'accent' && 'bg-[linear-gradient(90deg,var(--accent),var(--accent-2))]',
        )}
        style={{ width: v + '%' }}
      />
    </div>
  );
}

export function Spinner({ size = 16, className }) {
  return <Loader2 size={size} className={clsx('animate-spin text-[var(--fg-3)]', className)} />;
}

export function Skeleton({ className, style }) {
  return <div className={clsx('skeleton rounded-xl', className)} style={style} />;
}

export function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center gap-3 px-6 py-14 text-center', className)}>
      {Icon ? (
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--line)] bg-white/[0.03] text-[var(--fg-3)]">
          <Icon size={20} />
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="m-0 text-[14px] font-medium text-[var(--fg-2)]">{title}</p>
        {description ? <p className="m-0 max-w-sm text-[12px] leading-relaxed text-[var(--fg-3)]">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Segmented({ value, onChange, options, className, size = 'sm' }) {
  return (
    <div className={clsx('inline-flex w-fit max-w-full flex-wrap items-center gap-1 self-start rounded-xl border border-[var(--line)] bg-black/20 p-1', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-lg font-medium transition-all duration-150',
              size === 'xs' ? 'h-6 px-2 text-[11.5px]' : 'h-7 px-2.5 text-[12px]',
              active
                ? 'bg-[linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,.045))] text-[var(--fg)] shadow-[inset_0_1px_0_rgba(255,255,255,.10)]'
                : 'text-[var(--fg-3)] hover:text-[var(--fg-2)]',
            )}
          >
            {o.icon ? <span className="shrink-0 opacity-80">{o.icon}</span> : null}
            {o.label}
            {o.count != null ? (
              <span className={clsx('rounded-full px-1.5 py-px text-[10px]', active ? 'bg-white/[0.12] text-[var(--fg-2)]' : 'bg-white/[0.04] text-[var(--fg-4)]')}>
                {o.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ---------------- Tooltip ----------------

export function Tooltip({ content, children, side = 'top' }) {
  if (!content) return children;
  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className="z-[300] rounded-lg border border-[var(--line-strong)] bg-[var(--panel-3)] px-2.5 py-1.5 text-[11.5px] text-[var(--fg-2)] shadow-lg"
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-[var(--panel-3)]" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export function Kbd({ children }) {
  return (
    <kbd className="rounded-md border border-[var(--line-strong)] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-[var(--fg-3)]">
      {children}
    </kbd>
  );
}
