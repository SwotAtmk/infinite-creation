// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  const { id } = await params;
  const url = new URL(req.url);
  const category = url.searchParams.get('category') || null;
  return NextResponse.json(Assets.list(id, category));
}

export async function POST(req, { params }) {
  const { id } = await params;
  const { category = 'other', name, description = '' } = await req.json().catch(() => ({}));
  if (!name) return NextResponse.json({ error: '缺少 name' }, { status: 400 });
  return NextResponse.json(Assets.create(id, { category, name, description }));
}
