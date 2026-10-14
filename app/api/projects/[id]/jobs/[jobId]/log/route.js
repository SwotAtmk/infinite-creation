// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, Projects, projectDir } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id, jobId } = await params;
  // id / jobId 都来自 URL，Next 的 route handler 会把 %2e%2e / %2f 解码成 '..' / '/'
  // （见 vercel/next.js#64952）。projectDir 只是 path.join(PROJECTS_DIR, id)，不含边界校验，
  // 因此必须先确认项目存在（保证 id 是库里的 uid、不含路径分隔符），并把 jobId 收敛为纯文件名。
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const logsDir = path.join(projectDir(id), 'logs');
  // 只认本项目的 job 记录（跨项目 jobId 不得借道读他项目日志）
  const job = Jobs.get(jobId);
  const own = job && job.projectId === id ? job : null;
  const safeName = path.basename(String(jobId || ''));
  const logPath = own?.logPath || path.join(logsDir, safeName + '.log');
  // 兜底：最终路径必须落在本项目 logs 目录内（防 jobId 穿越）
  if (!path.resolve(logPath).startsWith(path.resolve(logsDir) + path.sep)) {
    return NextResponse.json({ error: '日志不存在' }, { status: 404 });
  }
  try {
    return NextResponse.json({ jobId, logPath, text: fs.readFileSync(logPath, 'utf8') });
  } catch {
    return NextResponse.json({ jobId, logPath, text: '' });
  }
}
