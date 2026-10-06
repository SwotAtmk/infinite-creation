'use client';
// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
//
// 非阻塞提示：替代 alert / window.confirm。
// 容器 pointer-events: none，只有提示条自身 pointer-events: auto ——
// 所以「没人关的提示」照样不挡网页操作，与原来的 .modal-bg（整屏遮罩）相反。
//
//   toast('已保存', 'success')        成功，5 秒后自消失
//   toast(e.message, 'error')         出错，不自动消失，点 × 关闭
//   await toast.confirm('删除？')      需要决策，返回 true/false；关掉按「否」处理
//   toast.open({ ... })               自定义按钮（如「前往运行日志」）
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const ToastCtx = createContext(null);

export function useToast() {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('useToast 需在 <ToastProvider> 内使用');
  return v;
}

let seq = 0;

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());

  const remove = useCallback((id) => {
    setItems((list) => list.filter((t) => t.id !== id));
    const tm = timers.current.get(id);
    if (tm) { clearTimeout(tm); timers.current.delete(id); }
  }, []);

  // 点 × 或超时关闭：待决策的 prompt 落到 false，动作不执行（失败安全）
  const dismiss = useCallback((id) => {
    setItems((list) => {
      const hit = list.find((t) => t.id === id);
      if (hit && hit.settle) hit.settle(false);
      return list.filter((t) => t.id !== id);
    });
    const tm = timers.current.get(id);
    if (tm) { clearTimeout(tm); timers.current.delete(id); }
  }, []);

  const open = useCallback((opt) => {
    const id = ++seq;
    const kind = opt.kind || 'info';
    let settle = null;
    if (opt.awaitAnswer) {
      let done = false;
      settle = (v) => { if (!done) { done = true; opt.onAnswer(v); } };
    }
    setItems((list) => [...list.slice(-4), {
      id, kind, message: String(opt.message == null ? '' : opt.message),
      input: opt.input ? { placeholder: opt.input.placeholder || '', value: opt.input.value || '', type: opt.input.type || 'text' } : null,
      buttons: Array.isArray(opt.buttons) ? opt.buttons : [], settle,
    }]);
    // 待决策项与错误不自消失，留给用户去点；成功/信息 5 秒后自消失
    if (kind === 'success' || kind === 'info') timers.current.set(id, setTimeout(() => dismiss(id), 5000));
    return id;
  }, [dismiss]);

  const api = useMemo(() => ({
    open,
    info: (message) => open({ kind: 'info', message }),
    success: (message) => open({ kind: 'success', message }),
    error: (message) => open({ kind: 'error', message }),
    confirm(message, opts = {}) {
      return new Promise((resolve) => {
        open({
          kind: opts.danger ? 'error' : 'warn',
          message,
          awaitAnswer: true,
          onAnswer: resolve,
          buttons: [
            { label: opts.confirmLabel || '确定', tone: opts.danger ? 'danger' : 'primary', value: true },
            { label: opts.cancelLabel || '取消', tone: 'plain', value: false },
          ],
        });
      });
    },
    // 需要文字输入（如换装描述）；空输入仍可选「确定」，由调用方自行校验
    prompt(message, opts = {}) {
      return new Promise((resolve) => {
        open({
          kind: opts.kind || 'info',
          message,
          input: { placeholder: opts.placeholder || '', value: opts.defaultValue || '' },
          awaitAnswer: true,
          onAnswer: (v) => resolve(typeof v === 'string' && v.trim() ? v : null),
          buttons: [
            { label: opts.confirmLabel || '确定', tone: 'primary', value: '__input__' },
            { label: opts.cancelLabel || '取消', tone: 'plain', value: null },
          ],
        });
      });
    },
    dismiss,
  }), [open, dismiss]);

  useEffect(() => {
    const map = timers.current;
    return () => { for (const t of map.values()) clearTimeout(t); };
  }, []);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={'toast toast-' + t.kind} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast-msg">
              {t.message}
              {t.input && (
                <input
                  className="toast-input"
                  type={t.input.type}
                  value={t.input.value}
                  placeholder={t.input.placeholder}
                  autoFocus
                  onChange={(e) => setItems((list) => list.map((x) => (x.id === t.id ? { ...x, input: { ...x.input, value: e.target.value } } : x)))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { const ok = t.buttons.find((b) => b.value === '__input__'); if (ok && t.settle) { t.settle(t.input.value); remove(t.id); } } }}
                />
              )}
            </span>
            {t.buttons.length > 0 && (
              <span className="toast-actions">
                {t.buttons.map((b, i) => (
                  <button
                    key={i}
                    className={b.tone === 'primary' ? 'primary' : b.tone === 'danger' ? 'danger' : ''}
                    onClick={() => {
                      if (t.settle) t.settle(b.value === '__input__' ? (t.input ? t.input.value : '') : b.value);
                      else if (b.onClick) b.onClick();
                      remove(t.id);
                    }}
                  >{b.label}</button>
                ))}
              </span>
            )}
            <button className="toast-x" aria-label="关闭提示" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
