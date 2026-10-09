'use client';
import { Spinner } from '@heroui/react';

// 全屏加载层：操作进行中显示，既提示等待又阻断重复点击；操作结束（成功或失败）后由调用方卸载
export default function LoadingOverlay({ show = false, text = '处理中…' }) {
  if (!show) return null;
  return (
    <div
      className="fixed inset-0 z-[400] flex flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <Spinner size="lg" color="primary" />
      <div className="text-sm text-white/90">{text}</div>
    </div>
  );
}
