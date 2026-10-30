// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 跨项目列出可复用的音色资产（voice），供数字人页「选择已有音色」使用。
import { NextResponse } from 'next/server';
import { Projects, Assets } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const out = [];
  for (const p of Projects.list()) {
    const assets = Assets.list(p.id, 'voice');
    for (const a of assets) {
      const ref = a.voice_ref || a.audio_path;
      if (!ref) continue;
      out.push({ id: a.id, project_id: p.id, project_name: p.name, name: a.name, ref_path: ref });
    }
  }
  return NextResponse.json(out);
}
