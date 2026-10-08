'use client';
// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
//
// 两类交互，分开处理：
// - 提示（toast）：非阻塞，右下角，一律不自动消失、点 × 关闭；
//   容器 pointer-events: none，没人关的提示也不挡网页操作
// - 决策（confirm/prompt）：阻塞弹窗（模态遮罩），必须作出选择才能继续操作，
//   防止弹窗被跳过导致误操作；关闭/取消按「否」处理（失败安全）
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const ToastCtx = createContext(null);

export function useToast() {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('useToast 需在 <ToastProvider> 内使用');
  return v;
}

let seq = 0;

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
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={'toast toast-' + t.kind} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast-msg">{t.message}</span>
            {t.buttons.length > 0 && (
              <span className="toast-actions">
                {t.buttons.map((b, i) => (
                  <button
                    key={i}
                    className={b.tone === 'primary' ? 'primary' : b.tone === 'danger' ? 'danger' : ''}
                    onClick={() => { if (b.onClick) b.onClick(); remove(t.id); }}
                  >{b.label}</button>
                ))}
              </span>
            )}
            <button className="toast-x" aria-label="关闭提示" onClick={() => remove(t.id)}>×</button>
          </div>
        ))}
      </div>

      {dialog && (
        <div className="modal-bg" style={{ zIndex: 400 }} onClick={() => answer(dialog.mode === 'prompt' ? null : false)}>
          <div className="modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, whiteSpace: 'pre-line' }}>{dialog.message}</h3>
            {dialog.mode === 'prompt' && (
              <input
                className="toast-input"
                style={{ marginTop: 10 }}
                autoFocus
                value={promptVal}
                placeholder={dialog.placeholder}
                onChange={(e) => setPromptVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { const v = promptVal.trim(); answer(v ? v : null); } }}
              />
            )}
            <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
              <button
                className={dialog.danger ? 'danger' : 'primary'}
                onClick={() => {
                  if (dialog.mode === 'prompt') { const v = promptVal.trim(); answer(v ? v : null); }
                  else answer(true);
                }}
              >{dialog.confirmLabel}</button>
              <button onClick={() => answer(dialog.mode === 'prompt' ? null : false)}>{dialog.cancelLabel}</button>
            </div>
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  );
}