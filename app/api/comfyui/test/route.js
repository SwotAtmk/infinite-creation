// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { loadConfig, checkBackend } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  // 优先测试前端输入框当前值（含 provider/apiKey/tier 的未保存状态），未传则回退到已保存配置
  let cfg;
  if (body && body.comfyui) cfg = { comfyui: body.comfyui };
  else if (body && body.baseUrl) cfg = { comfyui: { provider: 'native', baseUrl: body.baseUrl } };
  else cfg = loadConfig();
  return NextResponse.json(await checkBackend(cfg));
}
