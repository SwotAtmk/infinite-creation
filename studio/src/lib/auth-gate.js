// 按需登录：进入 Studio 不再强制登录，只有用户触发需要身份的操作（新建项目、写操作等）时才弹框。
// App 挂载时注册 handler，其他模块（api.js / 各页面）通过 requireAuth() 触发，返回 Promise<boolean>。
let handler = null;
let enabled = false;
let user = null;

export function setAuthGateHandler(fn) {
  handler = fn;
}

// 由 App 在鉴权状态变化时同步；api.js 用它判断 401 该弹登录还是该提示宿主会话。
export function setAuthState({ authEnabled, user: currentUser }) {
  enabled = !!authEnabled;
  user = currentUser || null;
}

export function isAuthEnabled() {
  return enabled;
}

export function isLoggedIn() {
  return !enabled || !!user;
}

/**
 * 需要登录时弹框，返回是否已登录：
 * - 未启用鉴权 / 已登录：直接 resolve(true)，不打扰用户
 * - 用户取消：resolve(false)
 */
export function requireAuth(reason) {
  if (!enabled || user) return Promise.resolve(true);
  if (!handler) return Promise.resolve(false);
  return Promise.resolve(handler(reason)).then(Boolean);
}
