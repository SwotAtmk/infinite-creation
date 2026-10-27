// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { loadConfig, checkBackend } from '@/lib/core/index.js';
import { authEnabled, currentAuthUser } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

// 测试连接会用服务端保存的 apiKey 发起真实请求，只允许管理员（或未启用鉴权的本地模式）
function canAdmin() {
  return !authEnabled() || currentAuthUser()?.role === 'admin';
}

export async function POST(req) {
  if (!canAdmin()) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  // 优先测试前端输入框当前值（含 provider/apiKey/tier 的未保存状态），未传则回退到已保存配置
  let cfg;
  if (body && body.comfyui) cfg = { comfyui: body.comfyui };
  else if (body && body.baseUrl) cfg = { comfyui: { provider: 'native', baseUrl: body.baseUrl } };
  else cfg = loadConfig();
  return NextResponse.json(await checkBackend(cfg));
}
