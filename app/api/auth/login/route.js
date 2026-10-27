import { NextResponse } from 'next/server';
import { createSession, verifyLogin } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

// 简单的登录失败限流：同一 IP + 用户名 10 分钟内最多 8 次失败，防暴力破解。
const failures = new Map();
const WINDOW = 10 * 60 * 1000;
const MAX_FAIL = 8;

function ipOf(req) {
  return String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';
}

function cookieHeader(token, req) {
  const secure = req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:';
  return `ic_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${secure ? '; Secure' : ''}`;
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const key = ipOf(req) + '|' + username;
  const now = Date.now();
  const rec = failures.get(key);
  if (rec && rec.until > now && rec.count >= MAX_FAIL) {
    return NextResponse.json({ error: '登录失败次数过多，请 10 分钟后再试' }, { status: 429 });
  }

  const user = verifyLogin(username, password);
  if (!user) {
    const next = rec && rec.until > now ? { count: rec.count + 1, until: rec.until } : { count: 1, until: now + WINDOW };
    failures.set(key, next);
    return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
  }
  failures.delete(key);

  const { token } = createSession(user.id);
  const res = NextResponse.json({ token, user });
  res.headers.append('Set-Cookie', cookieHeader(token, req));
  return res;
}
