export default function PageHeader({ eyebrow, title, description, actions, className }) {
  return (
    <div className={'flex flex-wrap items-end justify-between gap-4 ' + (className || '')}>
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 className="m-0 mt-1 text-[20px] font-semibold tracking-[-.015em] text-[var(--fg)]">{title}</h2>
        {description ? <p className="m-0 mt-1.5 max-w-2xl text-[12px] leading-relaxed text-[var(--fg-3)]">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
