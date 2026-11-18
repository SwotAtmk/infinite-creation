// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { analyzeWorkflow } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

// 自动分析工作流节点 JSON，产出一个候选规格（roles/outputs/media + 诊断信息），
// 供前端的引导式工作流配置表单在「自动分析」时使用。
export async function POST(req) {
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
  return NextResponse.json(analyzeWorkflow(structure, {
    kindGuess: body?.kindGuess || 'custom',
    name: body?.name || '',
  }));
}
