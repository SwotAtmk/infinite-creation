import { NextResponse } from 'next/server';
import { authEnabled, authenticateRequest, createUser, listUsers } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

function adminOf(req) {
  if (!authEnabled()) return { id: 'local', role: 'admin', username: 'local' };
  const user = authenticateRequest(req, new URL(req.url));
  return user && user.role === 'admin' ? user : null;
}

export async function GET(req) {
  if (!adminOf(req)) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
  return NextResponse.json({ users: listUsers() });
}

export async function POST(req) {
  if (!adminOf(req)) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  try {
    const user = createUser({
      username: body.username,
      password: body.password,
      role: body.role,
      perms: body.perms && typeof body.perms === 'object' ? body.perms : null,
    });
    return NextResponse.json({ user });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
