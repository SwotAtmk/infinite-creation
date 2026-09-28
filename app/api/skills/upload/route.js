// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { installSkillsFromZip, scanSkills } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) return NextResponse.json({ error: '缺少 zip 文件内容' }, { status: 400 });
    const filename = decodeURIComponent(req.headers.get('x-filename') || '');
    const installed = installSkillsFromZip(buf, { sourceName: filename });
    const skills = scanSkills();
    return NextResponse.json({ installed, skills });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
