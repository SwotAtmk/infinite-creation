// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { loadConfig, checkComfyUI } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  // 优先测试前端输入框当前值，未传则回退到已保存配置
  const baseUrl = (body && body.baseUrl) || loadConfig().comfyui.baseUrl;
  return NextResponse.json(await checkComfyUI(baseUrl));
}
