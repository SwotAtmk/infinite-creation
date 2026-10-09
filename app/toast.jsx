'use client';
// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
//
// 两类交互，分开处理：
// - 提示（toast）：非阻塞，右下角，一律不自动消失、点 × 关闭；
//   容器 pointer-events: none，没人关的提示也不挡网页操作
// - 决策（confirm/prompt）：阻塞弹窗（模态遮罩），必须作出选择才能继续操作，
//   防止弹窗被跳过导致误操作；关闭/取消按「否」处理（失败安全）
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Button, Input, Modal, ModalContent, ModalBody, ModalFooter } from '@heroui/react';

const ToastCtx = createContext(null);

export function useToast() {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('useToast 需在 <ToastProvider> 内使用');
  return v;
}

let seq = 0;

const KIND_BORDER = {
  info: 'border-l-primary',
  success: 'border-l-success',
  warn: 'border-l-warning',
  error: 'border-l-danger',
};

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  // 阻塞式决策弹窗：渲染数据放 state，resolver 放 ref（避免 setState updater 里带副作用）
  const [dialog, setDialog] = useState(null);
  const [promptVal, setPromptVal] = useState('');
  const dialogRef = useRef(null);

  const remove = useCallback((id) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const ask = useCallback((d) => {
    dialogRef.current = d;
    if (d.mode === 'prompt') setPromptVal(d.defaultValue || '');
    setDialog({ mode: d.mode, message: d.message, danger: !!d.danger, confirmLabel: d.confirmLabel, cancelLabel: d.cancelLabel, placeholder: d.placeholder || '' });
  }, []);

  // 只允许答一次：dialogRef 置空后，重复调用（连点、StrictMode）不再生效
  const answer = useCallback((v) => {
    const d = dialogRef.current;
    dialogRef.current = null;
    setDialog(null);
    if (d) d.resolve(v);
  }, []);

  const confirm = useCallback((message, opts = {}) => new Promise((resolve) => {
    ask({ mode: 'confirm', message, danger: !!opts.danger, confirmLabel: opts.confirmLabel || '确定', cancelLabel: opts.cancelLabel || '取消', resolve });
  }), [ask]);

  const prompt = useCallback((message, opts = {}) => new Promise((resolve) => {
    ask({ mode: 'prompt', message, placeholder: opts.placeholder || '', defaultValue: opts.defaultValue || '', confirmLabel: opts.confirmLabel || '确定', cancelLabel: opts.cancelLabel || '取消', resolve });
  }), [ask]);

  const open = useCallback((opt) => {
    const id = ++seq;
    setItems((list) => [...list.slice(-4), {
      id,
      kind: opt.kind || 'info',
      message: String(opt.message == null ? '' : opt.message),
      buttons: Array.isArray(opt.buttons) ? opt.buttons : [],
    }]);
    return id;
  }, []);

  const api = useMemo(() => ({
    open,
    info: (message) => open({ kind: 'info', message }),
    success: (message) => open({ kind: 'success', message }),
    error: (message) => open({ kind: 'error', message }),
    confirm,
    prompt,
    dismiss: remove,
  }), [open, confirm, prompt, remove]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="fixed right-4 bottom-16 z-[300] flex flex-col gap-2.5 items-end pointer-events-none max-w-[min(480px,92vw)]">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast toast-in pointer-events-auto bg-content1 text-foreground border border-default-200 border-l-[3px] rounded-lg p-2.5 flex gap-2 items-start shadow-lg text-sm ${KIND_BORDER[t.kind] || KIND_BORDER.info}`}
            role={t.kind === 'error' ? 'alert' : 'status'}
          >
            <span className="flex-1 whitespace-pre-line break-words leading-relaxed min-w-[140px]">{t.message}</span>
            {t.buttons.length > 0 && (
              <span className="flex gap-1.5 items-center shrink-0">
                {t.buttons.map((b, i) => (
                  <Button
                    key={i}
                    size="sm"
                    color={b.tone === 'primary' ? 'primary' : b.tone === 'danger' ? 'danger' : 'default'}
                    variant={b.tone ? 'solid' : 'flat'}
                    onPress={() => { if (b.onClick) b.onClick(); remove(t.id); }}
                  >{b.label}</Button>
                ))}
              </span>
            )}
            <Button isIconOnly size="sm" variant="light" aria-label="关闭提示" onPress={() => remove(t.id)}>×</Button>
          </div>
        ))}
      </div>

      <Modal
        isOpen={!!dialog}
        size="sm"
        backdrop="blur"
        onClose={() => answer(dialog.mode === 'prompt' ? null : false)}
      >
        <ModalContent>
          {() => (
            <>
              <ModalBody>
                <div className="whitespace-pre-line pt-3">{dialog.message}</div>
                {dialog.mode === 'prompt' && (
                  <Input
                    autoFocus
                    value={promptVal}
                    placeholder={dialog.placeholder}
                    onChange={(e) => setPromptVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { const v = promptVal.trim(); answer(v ? v : null); } }}
                  />
                )}
              </ModalBody>
              <ModalFooter>
                <Button
                  color={dialog.danger ? 'danger' : 'primary'}
                  onPress={() => {
                    if (dialog.mode === 'prompt') { const v = promptVal.trim(); answer(v ? v : null); }
                    else answer(true);
                  }}
                >{dialog.confirmLabel}</Button>
                <Button variant="flat" onPress={() => answer(dialog.mode === 'prompt' ? null : false)}>{dialog.cancelLabel}</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </ToastCtx.Provider>
  );
}