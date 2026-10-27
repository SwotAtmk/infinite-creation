// 账号与会话：独立模块，不依赖 Next。密码用 scrypt 加盐，会话令牌只存哈希。
//
// 启用方式：IC_AUTH=1（通常由 start-studio.bat 设置）。未启用时，所有请求视为本地管理员。
// 令牌来源优先级：Authorization: Bearer → cookie ic_auth → ?token= （用于 <img>/WS，无法带头）。
import crypto from 'node:crypto';
import { getDb } from './db.js';
import { currentUser } from './context.js';
import { loadConfig } from './config.js';

export const COOKIE_NAME = 'ic_auth';
const SESSION_DAYS = 7;
const MAX_TOKEN = 512;

let tablesReady = false;

// 账号表结构单独导出：数据库迁移脚本需要在目标库先建这两张表（它们不在 db.js 的主 schema 里）。
export const AUTH_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
  `;

function ensureTables() {
  if (tablesReady) return;
  const db = getDb();
  db.exec(AUTH_SCHEMA_SQL);
  // 权限与外部身份（SSO）：逐列补，旧库自动升级
  for (const sql of [
    "ALTER TABLE users ADD COLUMN perms TEXT DEFAULT '{}'",
    "ALTER TABLE users ADD COLUMN external_id TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN source TEXT DEFAULT 'local'",
  ]) {
    try {
      db.exec(sql);
    } catch {
      /* 列已存在 */
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_users_external ON users(external_id)");
  // 旧项目（账号体系上线前创建）owner_id 为空：归到第一个管理员，避免“项目没人付费/估算余额为 0”。
  // 新建项目的 owner 由服务端写入，不受影响。
  try {
    const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND disabled=0 ORDER BY created_at ASC LIMIT 1").get();
    if (admin) db.prepare("UPDATE projects SET owner_id=? WHERE owner_id IS NULL OR owner_id=''").run(admin.id);
  } catch {
    /* projects 表还没建好时忽略 */
  }
  tablesReady = true;
}

// —— 角色与功能权限 ——
// 角色只决定默认值；每个用户可以再单独覆盖（perms JSON）。
// admin 永远拥有全部权限（避免误把唯一管理员锁死）。
export const PERMISSIONS = ['create_project', 'edit', 'generate', 'export'];

export function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'admin') return 'admin';
  if (r === 'viewer' || r === 'readonly') return 'viewer';
  return 'creator'; // 'user' 兼容旧数据
}

export function defaultPermissions(role) {
  const r = normalizeRole(role);
  const all = r === 'admin' || r === 'creator';
  return Object.fromEntries(PERMISSIONS.map((k) => [k, all]));
}

export function effectivePermissions(user) {
  if (!user) return defaultPermissions('viewer');
  const base = defaultPermissions(user.role);
  const stored = user.perms && typeof user.perms === 'object' ? user.perms : {};
  const out = {};
  for (const k of PERMISSIONS) out[k] = stored[k] === undefined ? base[k] : !!stored[k];
  if (normalizeRole(user.role) === 'admin') for (const k of PERMISSIONS) out[k] = true;
  return out;
}

export function hasPermission(user, key) {
  if (!user) return false;
  if (normalizeRole(user.role) === 'admin') return true;
  return effectivePermissions(user)[key] === true;
}

function parsePerms(raw) {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// 登录开关优先级：config.auth.enabled（布尔，可在后台/独立路由运行时切换）
//   → 未设置时跟随启动脚本的 IC_AUTH（'1' 开启，其余关闭）。
// 配置读取做 2 秒缓存，避免每个请求都读盘；切换后最多 2 秒生效。
let authModeCache = { at: 0, value: false };
export function resetAuthModeCache() {
  authModeCache = { at: 0, value: false };
}

export function authEnabled() {
  const t = Date.now();
  if (t - authModeCache.at < 2000) return authModeCache.value;
  let v;
  if (process.env.IC_AUTH === '0') {
    v = false;
  } else {
    try {
      const c = loadConfig();
      v = typeof c.auth?.enabled === 'boolean' ? c.auth.enabled : process.env.IC_AUTH === '1';
    } catch {
      v = process.env.IC_AUTH === '1';
    }
  }
  authModeCache = { at: t, value: v };
  return v;
}

function uid() {
  return crypto.randomUUID();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

function verifyPassword(password, stored) {
  try {
    const [kind, salt, hash] = String(stored || '').split('$');
    if (kind !== 'scrypt' || !salt || !hash) return false;
    const calc = crypto.scryptSync(String(password), salt, 64);
    const expect = Buffer.from(hash, 'hex');
    return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
  } catch {
    return false;
  }
}

function publicUser(row) {
  if (!row) return null;
  const role = normalizeRole(row.role);
  const perms = parsePerms(row.perms);
  const user = {
    id: row.id,
    username: row.username,
    role,
    disabled: !!row.disabled,
    perms,
    externalId: row.external_id || '',
    source: row.source || 'local',
  };
  user.permissions = effectivePermissions(user);
  return user;
}

export function countUsers() {
  ensureTables();
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

// 展示项目判定：归属于管理员（未禁用）的项目对所有访客只读可见。
// 做 5 秒缓存——/files/ 下的每个媒体请求都会查一次，不能每次都打库。
let adminCache = { at: 0, ids: new Set() };
function adminIds() {
  const t = Date.now();
  if (t - adminCache.at > 5000) {
    let ids = new Set();
    try {
      ids = new Set(getDb().prepare("SELECT id FROM users WHERE role='admin' AND disabled=0").all().map((r) => r.id));
    } catch {
      /* 表还没建好：当作没有管理员 */
    }
    adminCache = { at: t, ids };
  }
  return adminCache.ids;
}

export function listAdminUserIds() {
  ensureTables();
  return [...adminIds()];
}

export function isAdminUser(id) {
  if (!id) return false;
  ensureTables();
  return adminIds().has(id);
}

export function listUsers() {
  ensureTables();
  return getDb().prepare('SELECT * FROM users ORDER BY created_at ASC').all().map(publicUser);
}

export function getUserById(id) {
  ensureTables();
  return publicUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(id));
}

export function createUser({ username, password, role = 'creator', perms = null, externalId = '', source = 'local' }) {
  ensureTables();
  const name = String(username || '').trim();
  if (!name || name.length > 64) throw new Error('用户名需为 1-64 个字符');
  if (String(password || '').length < 8) throw new Error('密码至少 8 位');
  if (getDb().prepare('SELECT id FROM users WHERE username = ?').get(name)) throw new Error('用户名已存在');
  const id = uid();
  const t = Date.now();
  getDb()
    .prepare('INSERT INTO users (id, username, password_hash, role, disabled, perms, external_id, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, name, hashPassword(password), normalizeRole(role), 0, JSON.stringify(perms || {}), String(externalId || ''), String(source || 'local'), t, t);
  adminCache = { at: 0, ids: new Set() };
  return publicUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(id));
}

export function setUser(id, { password, role, disabled, perms }) {
  ensureTables();
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return null;
  const nextRole = role === undefined ? normalizeRole(row.role) : normalizeRole(role);
  const nextDisabled = disabled === undefined ? row.disabled : disabled ? 1 : 0;
  const nextHash = password ? hashPassword(password) : row.password_hash;
  const nextPerms = perms === undefined ? row.perms : JSON.stringify(perms && typeof perms === 'object' ? perms : {});
  getDb()
    .prepare('UPDATE users SET password_hash=?, role=?, disabled=?, perms=?, updated_at=? WHERE id=?')
    .run(nextHash, nextRole, nextDisabled, nextPerms || '{}', Date.now(), id);
  if (nextDisabled) getDb().prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
  adminCache = { at: 0, ids: new Set() };
  return publicUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(id));
}

// SSO：按外部身份（JWT 的 sub）自动建号/同步角色与权限。
// 不覆盖本地已存在的密码账号；用户名冲突时自动加后缀。
export function upsertSsoUser({ externalId, username, role = 'creator', perms = null }) {
  ensureTables();
  const db = getDb();
  const ext = String(externalId || '').trim();
  if (!ext) throw new Error('JWT 缺少用户标识（sub）');
  const r = normalizeRole(role);
  const permsJson = JSON.stringify(perms && typeof perms === 'object' ? perms : {});
  const existing = db.prepare('SELECT * FROM users WHERE external_id = ?').get(ext);
  const t = Date.now();
  if (existing) {
    db.prepare('UPDATE users SET role=?, perms=?, updated_at=? WHERE id=?').run(r, permsJson, t, existing.id);
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id));
  }
  let name = String(username || '').trim().slice(0, 64) || 'sso_' + ext.slice(0, 8);
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(name)) {
    name = (name.slice(0, 50) + '_' + ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)).slice(0, 64);
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(name)) {
    name = name.slice(0, 56) + '_' + crypto.randomBytes(3).toString('hex');
  }
  const id = uid();
  // password_hash 留空：SSO 账号不能走用户名密码登录
  db.prepare('INSERT INTO users (id, username, password_hash, role, disabled, perms, external_id, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, name, '', r, 0, permsJson, ext, 'sso', t, t);
  adminCache = { at: 0, ids: new Set() };
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

export function verifyLogin(username, password) {
  ensureTables();
  const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!row || row.disabled) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return publicUser(row);
}

export function createSession(userId) {
  ensureTables();
  const token = crypto.randomBytes(32).toString('base64url');
  const t = Date.now();
  getDb()
    .prepare('INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(uid(), userId, hashToken(token), t + SESSION_DAYS * 86400_000, t);
  return { token, expiresAt: t + SESSION_DAYS * 86400_000 };
}

export function deleteSession(token) {
  if (!token) return;
  ensureTables();
  getDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
}

export function getUserByToken(token) {
  const raw = String(token || '').slice(0, MAX_TOKEN);
  if (!raw) return null;
  ensureTables();
  const row = getDb()
    .prepare(
      'SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0',
    )
    .get(hashToken(raw), Date.now());
  return publicUser(row);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function headerValue(req, name) {
  const h = req?.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return String(h.get(name) || '');
  const lower = name.toLowerCase();
  for (const key of Object.keys(h)) {
    if (key.toLowerCase() === lower) return String(h[key] || '');
  }
  return '';
}

export function tokenFromRequest(req, url, { allowQuery = true } = {}) {
  const auth = headerValue(req, 'authorization');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const cookies = parseCookies(headerValue(req, 'cookie'));
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  // ?token= 只给无法带头的场景（<img> / WebSocket 握手）。
  // 管理类接口必须关掉它：URL 会进访问日志、Referer、浏览器历史。
  if (!allowQuery) return '';
  const q = url?.searchParams?.get('token');
  return q || '';
}

export function authenticateRequest(req, url) {
  if (!authEnabled()) {
    // 免登录模式：普通浏览/使用视为本地管理员（管理后台另有严格校验）
    return { id: 'local', username: 'local', role: 'admin', disabled: false };
  }
  const token = tokenFromRequest(req, url);
  return getUserByToken(token);
}

// 严格校验：**始终**按令牌验证，不受 IC_AUTH / auth.enabled 影响；
// 且只接受 Authorization / cookie —— 管理接口不接受 ?token=（会留在日志与 Referer 里）。
// 管理后台与配置类接口用它：即使整站免登录，管理页面也必须登录管理员账号。
export function authenticateStrict(req, url) {
  const token = tokenFromRequest(req, url, { allowQuery: false });
  return getUserByToken(token);
}

export function isAuthPublicPath(pathname) {
  return pathname === '/api/health' || pathname.startsWith('/api/auth/') || pathname === '/api/moderation/check';
}

export function bootstrapAdmin({ username, password }) {
  ensureTables();
  if (countUsers() > 0) throw new Error('管理员已存在，请直接登录');
  const user = createUser({ username, password, role: 'admin' });
  // 首次创建管理员时，把历史项目（owner_id 为空）归到管理员名下
  try {
    getDb().prepare("UPDATE projects SET owner_id = ? WHERE owner_id IS NULL OR owner_id = ''").run(user.id);
  } catch {
    /* 旧库没有 owner_id 时忽略 */
  }
  return user;
}

export function currentAuthUser() {
  return currentUser();
}
