// 客户端登录令牌：localStorage 持久化，API 走 Authorization，静态资源/WS 走 ?token=
const KEY = 'ic.studio.auth.v1';
let token = '';

function read() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function getAuthToken() {
  if (!token) token = read();
  return token;
}

export function setAuthToken(value) {
  token = String(value || '');
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* 隐私模式忽略 */
  }
}

export function clearAuthToken() {
  setAuthToken('');
}

export function authHeaders(extra) {
  const t = getAuthToken();
  return t ? { ...(extra || {}), Authorization: 'Bearer ' + t } : extra || {};
}
