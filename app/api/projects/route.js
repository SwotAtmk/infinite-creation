// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, Assets, Shots, ensureProjectDirs } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const list = Projects.list().map((p) => ({
    id: p.id, name: p.name, style: p.style, status: p.status,
    assetCount: Assets.list(p.id).length, shotCount: Shots.list(p.id).length,
    updatedAt: p.updated_at,
  }));
  return NextResponse.json(list);
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const p = Projects.create(body || {});
  ensureProjectDirs(p.id);
  return NextResponse.json(p);
}
