// 画面风格选择器：半开放式 —— 默认只平铺「常用风格」，点「更多风格」在同一表单里向下展开
// 全部题材分组（限高滚动），不另开弹窗；已选项若不在常用列表里会顶到最前面，避免选中了看不见。
import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { STYLE_GROUPS, STYLE_CUSTOM, STYLE_COMMON } from '../lib/shared.js';

export default function StylePicker({ value, onChange, emptyLabel = '不指定' }) {
  const [expanded, setExpanded] = useState(false);
  const selected = (value || '').trim();
  const inline = selected && !STYLE_COMMON.includes(selected) ? [selected, ...STYLE_COMMON] : STYLE_COMMON;
  const pick = (style) => {
    onChange(style);
    setExpanded(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <StyleChip active={!selected} onClick={() => pick('')}>
          {emptyLabel}
        </StyleChip>
        {inline.map((s) => (
          <StyleChip key={s} active={selected === s} onClick={() => pick(s)}>
            {s}
          </StyleChip>
        ))}
        <StyleChip
          active={selected === STYLE_CUSTOM}
          onClick={() => {
            onChange(STYLE_CUSTOM);
            setExpanded(false);
          }}
        >
          {STYLE_CUSTOM}
        </StyleChip>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1.5 text-[12px] transition-all duration-150',
            expanded
              ? 'border-[color-mix(in_srgb,var(--accent)_45%,transparent)] text-[var(--accent)]'
              : 'border-[var(--line-strong)] text-[var(--fg-2)] hover:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] hover:text-[var(--accent)]',
          )}
        >
          {expanded ? '收起风格' : '更多风格'}
          <ChevronDown size={12} className={clsx('transition-transform duration-150', expanded && 'rotate-180')} />
        </button>
      </div>

      {expanded ? (
        <div className="flex max-h-[300px] flex-col gap-3 overflow-y-auto rounded-xl border border-[var(--line)] bg-white/[0.015] p-3">
          {STYLE_GROUPS.map((g) => (
            <div key={g.label}>
              <div className="mb-1.5 text-[10.5px] tracking-[.08em] text-[var(--fg-4)]">{g.label}</div>
              <div className="flex flex-wrap gap-1.5">
                {g.styles.map((s) => (
                  <StyleChip key={s} active={selected === s} onClick={() => pick(s)}>
                    {s}
                  </StyleChip>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function StyleChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded-full border px-3 py-1.5 text-[12px] transition-all duration-150',
        active
          ? 'border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]'
          : 'border-[var(--line)] bg-white/[0.02] text-[var(--fg-3)] hover:border-[var(--line-strong)] hover:text-[var(--fg-2)]',
      )}
    >
      {children}
    </button>
  );
}
