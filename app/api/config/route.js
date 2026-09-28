// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { loadConfig, saveConfig } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(loadConfig());
}

export async function PUT(req) {
  const body = await req.json().catch(() => ({}));
  return NextResponse.json(saveConfig(body || {}));
}
