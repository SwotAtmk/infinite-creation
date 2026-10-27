// 与主应用同一套 API 契约；studio 通过 Vite 代理把这些请求转发到 4600 主服务。
import { sessionHeaders } from './session.js';
import { authHeaders } from './auth.js';
import { isAuthEnabled, requireAuth } from './auth-gate.js';

const BASE = '';

// 只读预览（访客 / 他人的展示项目）：前端兜底拦截所有写请求。
// 真正的权限校验在服务端（server.js 对展示项目的非本人写操作返回 403），这里只是避免用户点了没反应。
let readOnlyMode = false;
export function setReadOnlyMode(v) {
  readOnlyMode = !!v;
}
export function isReadOnlyMode() {
  return readOnlyMode;
}

function headers(extra) {
  return authHeaders(sessionHeaders(extra));
}

async function req(method, url, body, isRetry = false) {
  const isAuthCall = url.startsWith('/api/auth/');
  if (readOnlyMode && method !== 'GET' && !isAuthCall) {
    throw new Error('预览模式：不能修改或生成');
  }
  const opts = { method, headers: headers({}) };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 401 = 未登录或令牌失效。
    // 注意排除认证接口本身：登录失败（用户名/密码错误）也返回 401，
    // 若在这里再弹登录框，会「登录框等请求、请求等登录框」直接卡死，错误提示也永远出不来。
    if (res.status === 401 && typeof window !== 'undefined' && !isAuthCall) {
      // 写操作才弹按需登录：登录成功后自动重放这一次请求，用户不必重新点一遍；
      // GET（如列表页首次加载）不弹框，交给页面渲染访客态，避免一进站就被登录打断。
      if (!isRetry && method !== 'GET' && isAuthEnabled()) {
        const ok = await requireAuth();
        if (ok) return req(method, url, body, true);
      }
      // 其余情况：401 需要宿主会话时由 App 统一渲染提示
      window.dispatchEvent(new CustomEvent('ic-studio:unauthorized'));
    }
    throw new Error(data.error || res.status + ' ' + res.statusText);
  }
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b),
  put: (u, b) => req('PUT', u, b),
  patch: (u, b) => req('PATCH', u, b),
  del: (u, b) => req('DELETE', u, b),
};

// 二进制上传：素材替换 / 技能包 zip。保持与主界面相同的请求头约定。
export async function uploadBinary(url, file, contentType) {
  const buf = await file.arrayBuffer();
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: headers({
      'Content-Type': contentType,
      'X-Filename': encodeURIComponent(file.name),
    }),
    body: buf,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

export async function uploadForm(url, formData) {
  const res = await fetch(BASE + url, { method: 'POST', headers: headers({}), body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}
