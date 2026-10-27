import { NextResponse } from 'next/server';
import { authEnabled, authenticateRequest, setUser } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

function adminOf(req) {
  if (!authEnabled()) return { id: 'local', role: 'admin', username: 'local' };
  const user = authenticateRequest(req, new URL(req.url));
  return user && user.role === 'admin' ? user : null;
}

export async function PATCH(req, { params }) {
  const admin = adminOf(req);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (id === admin.id && body.disabled) return NextResponse.json({ error: '不能停用当前登录账号' }, { status: 400 });
  try {
    const user = setUser(id, {
      password: body.password,
      role: body.role,
      disabled: body.disabled,
      perms: body.perms && typeof body.perms === 'object' ? body.perms : undefined,
    });
    if (!user) return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    return NextResponse.json({ user });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
