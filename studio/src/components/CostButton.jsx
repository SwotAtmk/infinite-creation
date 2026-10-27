// 费用按钮：默认只显示原始文字；悬停/聚焦时原文字淡出、费用高亮顶上来。
// 这样列表里大量重复的生成按钮不会一直挂着一串金额。
import { Button } from './ui.jsx';

export default function CostButton({ cost, children, className = '', title, variant = 'secondary', ...rest }) {
  // 把费用也写进原生 title：按钮被禁用时 CSS hover 可能不触发，
  // 但鼠标悬停仍能看到「免费 / 约 X 点」，不会出现完全没有费用提示的情况。
  const hint = cost ? (title ? title + ' · ' + cost : '预计费用 ' + cost) : title;
  if (!cost) {
    return (
      <Button variant={variant} className={className} title={hint} {...rest}>
        {children}
      </Button>
    );
  }
  // 费用文字的颜色必须跟随按钮底色：
  // primary 是金色底，再用金色字会看不清 → 用深色；danger 用白；其余暗底用金色。
  const costTone =
    variant === 'primary'
      ? 'text-[#1B1408]'
      : variant === 'danger'
        ? 'text-white'
        : 'text-[var(--accent)]';
  return (
    <Button variant={variant} className={'group/cost ' + className} title={hint} {...rest}>
      <span className="inline-flex items-center gap-1 transition-opacity duration-150 group-hover/cost:opacity-0 group-focus-visible/cost:opacity-0">
        {children}
      </span>
      <span
        className={
          'pointer-events-none absolute inset-0 z-10 flex items-center justify-center whitespace-nowrap px-1.5 text-[11px] font-bold tracking-wide opacity-0 transition-opacity duration-150 group-hover/cost:opacity-100 group-focus-visible/cost:opacity-100 '
          + costTone
        }
      >
        {cost}
      </span>
    </Button>
  );
}
