// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { scanSkills } from '@/lib/agent/index.js';
import { authEnabled, currentAuthUser } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

function canAdmin() {
  return !authEnabled() || currentAuthUser()?.role === 'admin';
}

export async function POST() {
  if (!canAdmin()) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
  return NextResponse.json(scanSkills());
}
