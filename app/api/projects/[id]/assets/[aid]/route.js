// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function PATCH(req, { params }) {
  const { aid } = await params;
  const body = await req.json().catch(() => ({}));
  return NextResponse.json(Assets.update(aid, body || {}));
}

export async function DELETE(_req, { params }) {
  const { aid } = await params;
  Assets.remove(aid);
  return NextResponse.json({ ok: true });
}
