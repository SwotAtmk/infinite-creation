// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { installSkillsFromZip, scanSkills } from '@/lib/agent/index.js';
import { authEnabled, currentAuthUser } from '@/lib/core/auth.js';
import { SKILL_ZIP_MAX_BYTES } from '@/lib/shared/index.js';

export const dynamic = 'force-dynamic';

function canAdmin() {
  return !authEnabled() || currentAuthUser()?.role === 'admin';
}

export async function POST(req) {
  // 技能包是全局共享资源（写入 skills/，会影响所有用户的任务），只允许管理员安装
  if (!canAdmin()) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
  try {
    // 与素材上传同一类问题：整个请求体（以及解压结果）都在内存里，没有上限时
    // 一个误选的大文件就能把进程撑爆 OOM。先按 Content-Length 早退，读完再兜一道。
    const limitMb = Math.round(SKILL_ZIP_MAX_BYTES / 1024 / 1024);
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > SKILL_ZIP_MAX_BYTES) return NextResponse.json({ error: '技能包过大：上限 ' + limitMb + 'MB' }, { status: 413 });
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) return NextResponse.json({ error: '缺少 zip 文件内容' }, { status: 400 });
    if (buf.length > SKILL_ZIP_MAX_BYTES) return NextResponse.json({ error: '技能包过大：上限 ' + limitMb + 'MB' }, { status: 413 });
    const filename = decodeURIComponent(req.headers.get('x-filename') || '');
    const installed = installSkillsFromZip(buf, { sourceName: filename });
    const skills = scanSkills();
    return NextResponse.json({ installed, skills });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
