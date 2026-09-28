// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { scanSkills } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json(scanSkills());
}
