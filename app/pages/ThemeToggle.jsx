'use client';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Button } from '@heroui/react';

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return <Button isIconOnly variant="light" aria-label="切换主题" isDisabled />;
  const isDark = theme === 'dark';
  return (
    <Button
      isIconOnly
      variant="light"
      aria-label="切换明暗主题"
      onPress={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? '☀️' : '🌙'}
    </Button>
  );
}