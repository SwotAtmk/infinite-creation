// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/core/index.js';
import { listModels } from '@/lib/core/cloud-api.js';

export const dynamic = 'force-dynamic';

// 拉某档网关的模型清单。baseUrl / apiKey 传的是设置框里的现值（可能还没保存），
// 不传则回退到已保存配置。失败也用 200 返回 { ok:false, error }，前端直接显示那句话。
export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const group = String(body.group || '');
  try {
    const models = await listModels(loadConfig(), group, {
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    });
    return NextResponse.json({ ok: true, models });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message, models: [] });
  }
}
