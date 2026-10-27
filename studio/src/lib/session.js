// 会话透传：宿主（外层项目）通过 iframe URL 或 postMessage 传入会话标识，
// Studio 把它附加到所有 API / WebSocket 请求上，供服务端做用户隔离或鉴权。
//
// 注意：会话标识本身只是「客户端声明」。真正的外部服务必须由服务端（或前置网关）
// 校验签名/令牌，并按会话隔离数据；前端透传不构成安全边界。
const KEY = 'ic.studio.session';
let token = '';

function readStored() {
  try {
    return sessionStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function setSessionToken(value) {
  token = String(value || '');
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用 */
  }
}

export function getSessionToken() {
  if (!token) token = readStored();
  return token;
}

export function initSessionFromUrl() {
  try {
    const p = new URLSearchParams(window.location.search);
    const t = p.get('session') || p.get('sessionId') || p.get('token');
    if (t) setSessionToken(t);
  } catch {
    /* noop */
  }
  return getSessionToken();
}

export function sessionHeaders(extra) {
  const t = getSessionToken();
  return t ? { ...(extra || {}), 'X-IC-Session': t } : extra || {};
}
