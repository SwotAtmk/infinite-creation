// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { loadConfig } from '@/lib/core/index.js';
import { collectSkillDirFiles } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// 导出流水线技能编排：根层 IC_CONFIG.json + 被引用技能目录，打包成 zip 供下载。
export async function GET() {
  try {
    const cfg = loadConfig();
    const sp = cfg.skillPipeline || { nodes: {} };
    const nodes = sp.nodes || {};

    // 收集所有被引用技能的并集，去重
    const names = new Set();
    for (const n of Object.values(nodes)) {
      if (n && Array.isArray(n.skills)) {
        for (const s of n.skills) {
          const t = String(s).trim();
          if (t) names.add(t);
        }
      }
    }

    const zip = new AdmZip();
    zip.addFile('IC_CONFIG.json', Buffer.from(JSON.stringify({ version: 1, skillPipeline: sp }, null, 2), 'utf8'));

    const bundled = [];
    for (const name of [...names].sort()) {
      const files = collectSkillDirFiles(name);
      if (!files.length) continue;
      for (const f of files) {
        zip.addFile('skills/' + name + '/' + f.rel, fs.readFileSync(f.abs));
      }
      bundled.push(name);
    }

    const buf = zip.toBuffer();
    return new NextResponse(buf, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': "attachment; filename*=UTF-8''pipeline-config.zip",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
