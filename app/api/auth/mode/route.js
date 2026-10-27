// 登录/免登录的独立控制入口（只接受管理员令牌）。
// 不再用「请求来自 127.0.0.1」作为放行条件：反向代理会把公网请求也变成 127.0.0.1，
// 任何基于网络位置的判断都可能被部署形态绕过。
// 忘记密码 / 后台进不去时的应急入口改为服务器本机执行脚本（不经 HTTP）：
//   node scripts/set-auth-mode.mjs false   # false=免登录，true=需要登录，auto=跟随 IC_AUTH
import { NextResponse } from 'next/server';
import { loadConfig, saveConfig } from '@/lib/core/index.js';
import { authenticateStrict, resetAuthModeCache } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

function isAdmin(req) {
  return authenticateStrict(req, new URL(req.url))?.role === 'admin';
}

export async function GET(req) {
  if (!isAdmin(req)) return NextResponse.json({ error: '需要管理员权限（请先登录管理员账号）' }, { status: 403 });
  const cfg = loadConfig();
  return NextResponse.json({
    enabled: typeof cfg.auth?.enabled === 'boolean' ? cfg.auth.enabled : null,
    envAuth: process.env.IC_AUTH === '1',
  });
}

export async function POST(req) {
  if (!isAdmin(req)) return NextResponse.json({ error: '需要管理员权限（请先登录管理员账号）' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  if (typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled 必须是布尔值' }, { status: 400 });
  }
  const cfg = loadConfig();
  saveConfig({ ...cfg, auth: { ...(cfg.auth || {}), enabled: body.enabled } });
  resetAuthModeCache();
  return NextResponse.json({ ok: true, enabled: body.enabled });
}
