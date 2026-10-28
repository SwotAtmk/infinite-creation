import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

// 右下角回到顶部：滚动超过一屏后出现；不参与布局，不会挡住内容。
export default function BackToTop() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 360);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <button
      type="button"
      aria-label="回到顶部"
      title="回到顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className={
        'fixed bottom-6 right-5 z-[250] flex h-10 w-10 items-center justify-center rounded-full border border-[var(--line-strong)] bg-[var(--panel-2)]/95 text-[var(--fg-2)] shadow-[0_16px_40px_-16px_rgba(0,0,0,.9)] backdrop-blur-md transition-all duration-200 hover:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] hover:text-[var(--accent)] '
        + (show ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0')
      }
    >
      <ArrowUp size={16} />
    </button>
  );
}
