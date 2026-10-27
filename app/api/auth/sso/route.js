// JWT 单点登录：父平台 iframe 传入短时 JWT，换取本系统会话。
// 配置在 config.json 的 auth.sso（后台可编辑）；未启用时直接拒绝。
import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/core/index.js';
import { jwtClaims, ssoConfig, ssoEnabled, verifyJwt } from '@/lib/core/sso.js';
import { createSession, upsertSsoUser } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const cfg = loadConfig();
  if (!ssoEnabled(cfg)) return NextResponse.json({ error: '未启用 JWT 单点登录' }, { status: 403 });
  const sso = ssoConfig(cfg);

  const body = await req.json().catch(() => ({}));
  const auth = String(req.headers.get('authorization') || '');
  const token = String(body?.jwt || (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '')).trim();
  if (!token) return NextResponse.json({ error: '缺少 jwt' }, { status: 400 });

  let payload;
  try {
    payload = verifyJwt(token, sso);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 401 });
  }

  try {
    const claims = jwtClaims(payload, sso);
    if (!claims.externalId) return NextResponse.json({ error: 'JWT 缺少用户标识（sub）' }, { status: 400 });
    const user = upsertSsoUser(claims);
    if (user.disabled) return NextResponse.json({ error: '账号已被停用' }, { status: 403 });
    const { token: sessionToken } = createSession(user.id);
    const res = NextResponse.json({ token: sessionToken, user });
    const secure = req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:';
    res.headers.append(
      'Set-Cookie',
      `ic_auth=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${secure ? '; Secure' : ''}`,
    );
    return res;
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
