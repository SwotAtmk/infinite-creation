// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Skills } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(Skills.list());
}
