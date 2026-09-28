// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Workflows } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(Workflows.list());
}
