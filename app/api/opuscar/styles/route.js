// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 无限・秩影：返回 lemo-opuscar 风格目录（供前端卡片展示与分类筛选）。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const file = path.join(SKILLS_DIR, 'lemo-opuscar', 'styleboard', 'catalog.json');
  if (!fs.existsSync(file)) return NextResponse.json([]);
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    const styles = (Array.isArray(list) ? list : []).map((s) => ({
      slug: s.slug,
      cn: s.cn,
      en: s.en,
      cat: s.cat,
      cat_en: s.cat_en,
      line_cn: s.line_cn,
      dur: s.dur,
    }));
    return NextResponse.json(styles);
  } catch {
    return NextResponse.json([]);
  }
}
