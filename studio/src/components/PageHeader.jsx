export default function PageHeader({ eyebrow, title, badge, description, actions, className }) {
  return (
    <div className={'flex flex-wrap items-end justify-between gap-4 ' + (className || '')}>
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 className="m-0 mt-1 flex items-center gap-2 text-[20px] font-semibold tracking-[-.015em] text-[var(--fg)]">
          {title}
          {badge ? (
            <span className="rounded-full border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
              {badge}
            </span>
          ) : null}
        </h2>
        {description ? <p className="m-0 mt-1.5 max-w-2xl text-[12px] leading-relaxed text-[var(--fg-3)]">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
