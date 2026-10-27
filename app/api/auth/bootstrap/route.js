import { NextResponse } from 'next/server';
import { bootstrapAdmin, countUsers, createSession } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

// 首次使用：仅在系统没有任何账号时允许创建第一个管理员。
export async function POST(req) {
  if (countUsers() > 0) return NextResponse.json({ error: '管理员已存在，请直接登录' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  try {
    const user = bootstrapAdmin({ username, password });
    const { token } = createSession(user.id);
    const secure = req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:';
    const res = NextResponse.json({ token, user });
    res.headers.append('Set-Cookie', `ic_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${secure ? '; Secure' : ''}`);
    return res;
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
