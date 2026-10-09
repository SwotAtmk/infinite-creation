'use client';
import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';

// 回到顶部：右下角悬浮按钮，滚动超过 400px 时显示
export default function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 400);
    window.addEventListener('scroll', onScroll);
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!show) return null;
  return (
    <Button
      isIconOnly
      color="primary"
      radius="full"
      className="fixed right-6 bottom-6 z-[200] shadow-lg"
      aria-label="回到顶部"
      title="回到顶部"
      onPress={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    >↑</Button>
  );
}