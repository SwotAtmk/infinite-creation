// 百度图像审核「测试连接」：管理员用当前表单值校验 Key/Secret。
import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/core/index.js';
import { baiduEnabled, baiduTestConnection } from '@/lib/core/baidu-moderation.js';
import { authEnabled, currentAuthUser } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

function canAdmin() {
  return !authEnabled() || currentAuthUser()?.role === 'admin';
}

export async function POST(req) {
  if (!canAdmin()) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const cfg = body?.baidu ? { moderation: { baidu: body.baidu } } : loadConfig();
  if (!baiduEnabled(cfg)) return NextResponse.json({ ok: false, error: '未启用或未填写 API Key / Secret Key' });
  try {
    await baiduTestConnection(cfg);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message });
  }
}
