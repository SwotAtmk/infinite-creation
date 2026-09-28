// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, projectDir } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id, jobId } = await params;
  const job = Jobs.get(jobId);
  const logPath = job?.logPath || path.join(projectDir(id), 'logs', jobId + '.log');
  try {
    return NextResponse.json({ jobId, logPath, text: fs.readFileSync(logPath, 'utf8') });
  } catch {
    return NextResponse.json({ jobId, logPath, text: '' });
  }
}
