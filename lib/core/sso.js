// JWT 单点登录（父平台嵌入 iframe 时使用）。
// 只做「验签 + 取 claims」，不依赖外部库；算法与密钥全部来自 config.json 的 auth.sso。
import crypto from 'node:crypto';

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function ssoConfig(cfg) {
  return (cfg && cfg.auth && cfg.auth.sso) || {};
}

export function ssoEnabled(cfg) {
  const s = ssoConfig(cfg);
  return !!s.enabled && (!!s.secret || !!s.publicKey);
}

/**
 * 校验 JWT 并返回 payload。
 * opts: { algorithm:'HS256'|'RS256', secret, publicKey, issuer, audience, clockToleranceSec }
 */
export function verifyJwt(token, opts = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('JWT 格式错误');
  const [h, p, sig] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8'));
    payload = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    throw new Error('JWT 解析失败');
  }

  const want = String(opts.algorithm || 'HS256').toUpperCase();
  const alg = String(header.alg || '').toUpperCase();
  if (alg !== want) throw new Error('JWT 算法不匹配：' + (alg || '未知'));
  const signingInput = h + '.' + p;
  const signature = b64urlDecode(sig);

  if (want === 'HS256') {
    if (!opts.secret) throw new Error('未配置 JWT 共享密钥（auth.sso.secret）');
    const expect = crypto.createHmac('sha256', opts.secret).update(signingInput).digest();
    if (expect.length !== signature.length || !crypto.timingSafeEqual(expect, signature)) {
      throw new Error('JWT 签名无效');
    }
  } else if (want === 'RS256') {
    if (!opts.publicKey) throw new Error('未配置 JWT 公钥（auth.sso.publicKey）');
    const ok = crypto.createVerify('RSA-SHA256').update(signingInput).verify(opts.publicKey, signature);
    if (!ok) throw new Error('JWT 签名无效');
  } else {
    throw new Error('不支持的 JWT 算法：' + want);
  }

  const now = Math.floor(Date.now() / 1000);
  const tol = Number(opts.clockToleranceSec) || 30;
  if (typeof payload.exp === 'number' && now > payload.exp + tol) throw new Error('JWT 已过期');
  if (typeof payload.nbf === 'number' && now + tol < payload.nbf) throw new Error('JWT 尚未生效');
  if (opts.issuer && payload.iss !== opts.issuer) throw new Error('JWT issuer 不匹配');
  if (opts.audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(opts.audience)) throw new Error('JWT audience 不匹配');
  }
  return payload;
}

// 按配置的 claim 名取值；缺省值兼容常见写法
export function jwtClaims(payload, opts = {}) {
  const sub = payload[opts.userIdClaim || 'sub'];
  const username = payload[opts.usernameClaim || 'username'] || payload.name || payload.preferred_username || '';
  const role = payload[opts.roleClaim || 'role'] || 'creator';
  const rawPerms = payload[opts.permsClaim || 'perms'];
  return {
    externalId: sub == null ? '' : String(sub),
    username: String(username || ''),
    role,
    perms: rawPerms && typeof rawPerms === 'object' && !Array.isArray(rawPerms) ? rawPerms : null,
  };
}
