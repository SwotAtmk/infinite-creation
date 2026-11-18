// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Workflows, WORKFLOWS_DIR } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const PUBLIC_MODE = process.env.IC_PUBLIC === '1';
const MAX_BYTES = 8 * 1024 * 1024;

// 由工作流名生成稳定的 spec.id / 文件名标识（仅保留安全字符，不含路径分隔符）。
function slugName(name) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return base || 'workflow';
}

export async function GET() {
  return NextResponse.json(Workflows.list());
}

// 提交自定义工作流：写入 workflows/<id>.json 源文件，并 upsert 一条 DB 记录（builtin=false）。
// 内置 DEFAULT_SPECS 由 server.js 启动时注册，不经过此接口；自定义记录会在下次启动时保留。
export async function POST(req) {
  if (PUBLIC_MODE) return NextResponse.json({ error: '公开模式下不允许创建自定义工作流' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  let structure = body?.structure;
  if (typeof body?.source === 'string') {
    try {
      structure = JSON.parse(body.source);
    } catch (e) {
      return NextResponse.json({ error: 'JSON 解析失败：' + e.message }, { status: 400 });
    }
  }
  if (!structure || typeof structure !== 'object' || Array.isArray(structure)) {
    return NextResponse.json({ error: 'structure 必须是工作流节点对象' }, { status: 400 });
  }
  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ error: '缺少 name' }, { status: 400 });
  const kind = String(body?.kind || 'custom').trim() || 'custom';

  const id = 'custom_' + slugName(name);
  const sourceFile = id + '.json';
  const text = JSON.stringify(structure, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    return NextResponse.json({ error: '工作流文件超过 8MB 限制' }, { status: 413 });
  }

  const incomingSpec = body?.spec && typeof body.spec === 'object' ? body.spec : {};
  const spec = { ...incomingSpec, id, kind, name, sourceFile, builtin: false };

  try {
    const abs = path.join(WORKFLOWS_DIR, sourceFile);
    const tmp = abs + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (e) {
    return NextResponse.json({ error: '保存失败：' + e.message }, { status: 500 });
  }

  const row = Workflows.upsert({ name, kind, sourceFile, spec, status: 'active' });
  return NextResponse.json({ ok: true, id, sourceFile, spec, row });
}
