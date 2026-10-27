import { NextResponse } from 'next/server';
import { checkFields } from '@/lib/core/moderation.js';

export const dynamic = 'force-dynamic';

const MAX_FIELDS = 30;
const MAX_CHARS = 200_000;

// 供 Next middleware 与 Studio 前端调用。只做审核，不落库。
export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const fields = body && typeof body.fields === 'object' && body.fields ? body.fields : null;
  const single = typeof body?.text === 'string' ? { [body.field || 'text']: body.text } : null;
  const input = fields || single;
  if (!input) return NextResponse.json({ error: '缺少待审核文本' }, { status: 400 });

  const entries = Object.entries(input).slice(0, MAX_FIELDS);
  let budget = MAX_CHARS;
  const clipped = {};
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || !v.trim()) continue;
    if (budget <= 0) break;
    const text = v.slice(0, budget);
    budget -= text.length;
    clipped[k] = text;
  }

  const results = await checkFields(clipped, { useLlm: body.useLlm !== false });
  const blocked = Object.entries(results).filter(([, r]) => !r.allow);
  if (blocked.length) {
    const [field, r] = blocked[0];
    // 服务自身异常用 503，别伪装成 422「内容违规」——否则中间件会回「内容不合规」，
    // 用户会以为是自己内容的问题，改半天提示词也过不了。
    if (r.serviceError) {
      return NextResponse.json(
        { allow: false, field, category: r.category, reason: r.reason, serviceError: true, results },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { allow: false, field, category: r.category, reason: r.reason, results },
      { status: 422 },
    );
  }
  return NextResponse.json({ allow: true, results });
}
