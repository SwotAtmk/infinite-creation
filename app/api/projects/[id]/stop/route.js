// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, Jobs } from '@/lib/core/index.js';
import { stopJob } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

export async function POST(_req, { params }) {
  const { id } = await params;
  const jobs = Jobs.list(id).filter((j) => j.status === 'running');
  for (const j of jobs) stopJob(j.id);
  Projects.update(id, { status: 'idle' });
  return NextResponse.json({ stopped: jobs.length });
}
