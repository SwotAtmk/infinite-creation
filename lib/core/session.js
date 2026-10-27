// 独立会话模块：只负责「解析 / 签发 / 校验会话令牌」，不依赖 Next、不依赖业务路由。
//
// 两种工作模式（由环境变量控制）：
//   1) 只透传（默认）：任何非空 token 都接受，前端用它区分宿主会话；
//   2) 签名校验：设置 IC_SESSION_SECRET 后，token 必须是本模块签发的
//      v1.<base64url(id)>.<exp>.<hmac>，过期或签名不符直接 401。
//
// IC_PUBLIC=1 且 IC_SESSION_REQUIRE=1 时，server.js 会对 /api、/files、/ws 启用强制校验；
// 本地经典界面不要打开 IC_SESSION_REQUIRE，否则它不会带会话头。
import crypto from 'node:crypto';

const HEADER = 'x-ic-session';
const MAX_ID = 128;

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromB64url(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function sessionSecret() {
  return process.env.IC_SESSION_SECRET || '';
}

export function sessionRequired() {
  return process.env.IC_PUBLIC === '1' && process.env.IC_SESSION_REQUIRE === '1';
}

function sanitizeId(id) {
  return String(id ?? '').trim().slice(0, MAX_ID);
}

// 从请求里取会话：优先请求头，其次 query（WebSocket / <img> / <a download> 无法带自定义头）
export function getSessionFromRequest(req, url) {
  const header = req?.headers?.[HEADER];
  if (typeof header === 'string' && header.trim()) return sanitizeId(header);
  const fromUrl = url?.searchParams?.get('session');
  if (fromUrl) return sanitizeId(fromUrl);
  return '';
}

export function mintSessionToken(sessionId, { secret = sessionSecret(), ttlSeconds = 24 * 3600 } = {}) {
  const id = sanitizeId(sessionId);
  if (!id) throw new Error('sessionId 不能为空');
  if (!secret) return id; // 未配置密钥：直接使用 id（仅存在性校验）
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, Number(ttlSeconds) || 86400);
  const payload = 'v1.' + b64url(id) + '.' + exp;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

export function verifySessionToken(token, { secret = sessionSecret() } = {}) {
  const raw = String(token || '');
  if (!raw) return { ok: false, error: '缺少会话标识' };
  if (!secret) return { ok: true, id: sanitizeId(raw) };

  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return { ok: false, error: '会话格式无效' };
  const [, idPart, expPart, sig] = parts;
  const exp = Number(expPart);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return { ok: false, error: '会话已过期' };

  const payload = 'v1.' + idPart + '.' + expPart;
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: '会话签名无效' };

  const id = sanitizeId(fromB64url(idPart));
  if (!id) return { ok: false, error: '会话语义无效' };
  return { ok: true, id };
}

// 请求级校验结果；server.js 只关心 ok / status / error。
export function sessionGate(req, url) {
  const token = getSessionFromRequest(req, url);
  if (!token) return { ok: false, status: 401, error: '缺少会话标识（X-IC-Session 或 ?session=）' };
  const checked = verifySessionToken(token);
  if (!checked.ok) return { ok: false, status: 401, error: checked.error };
  return { ok: true, sessionId: checked.id, token };
}
