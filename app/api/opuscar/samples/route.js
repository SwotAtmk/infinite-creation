// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 无限・秩影：内置样例库。样例文件放在 public/samples/<id>/ 下，
// 目录内 sample.json 描述风格、提示词、成片与素材清单；返回可直接访问的 URL。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const SAMPLES_DIR = path.join(ROOT, 'public', 'samples');
const KINDS = ['image', 'audio', 'video', 'file'];

function fileUrl(id, rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  if (!parts.length) return '';
  if (parts.some((p) => p === '..' || p === '.')) return '';
  return '/samples/' + encodeURIComponent(id) + '/' + parts.map(encodeURIComponent).join('/');
}

export async function GET() {
  if (!fs.existsSync(SAMPLES_DIR)) return NextResponse.json([]);
  const out = [];
  const dirs = fs.readdirSync(SAMPLES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    const file = path.join(SAMPLES_DIR, dir, 'sample.json');
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const id = raw.id || dir;
      const style = raw.style || {};
      const materials = (raw.materials || [])
        .filter((m) => m && m.file)
        .map((m) => ({
          type: KINDS.includes(m.type) ? m.type : 'file',
          name: m.name || path.basename(m.file),
          url: fileUrl(dir, m.file),
        }))
        .filter((m) => m.url);
      const video = fileUrl(dir, raw.video);
      out.push({
        id,
        name: raw.name || id,
        description: raw.description || '',
        style,
        prompt: raw.prompt || '',
        video,
        materials,
      });
    } catch {
      // 单个样例损坏不影响其它样例
    }
  }
  return NextResponse.json(out);
}
