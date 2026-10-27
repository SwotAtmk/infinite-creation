import { NextResponse } from 'next/server';
import { deleteSession, tokenFromRequest } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const url = new URL(req.url);
  const token = tokenFromRequest(req, url);
  deleteSession(token);
  const res = NextResponse.json({ ok: true });
  res.headers.append('Set-Cookie', 'ic_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return res;
}
