// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { loadConfig, saveConfig } from '@/lib/core/index.js';
import { authenticateStrict, resetAuthModeCache } from '@/lib/core/auth.js';
import { resetModerationCache } from '@/lib/core/moderation.js';

export const dynamic = 'force-dynamic';

// 是否拥有管理员权限：始终按令牌严格校验。
// 免登录只影响浏览/使用；管理后台与配置修改永远要求管理员账号登录。
function isLocalAdmin(req) {
  const user = authenticateStrict(req, new URL(req.url));
  return user?.role === 'admin';
}

// 对 C 端开放时设置环境变量 IC_PUBLIC=1：
//   · GET 不再返回任何密钥（RunningHub / LLM），页面被外网用户打开始终拿不到 Key；
//   · PUT 直接拒绝，避免外部用户覆盖或清空服务端配置。
// 密钥只在服务端 config.json / 生成请求内部使用，不会经由本接口下发到浏览器。
const PUBLIC_MODE = process.env.IC_PUBLIC === '1';

function redactConfig(cfg) {
  return {
    ...cfg,
    comfyui: { ...(cfg.comfyui || {}), apiKey: '' },
    llm: { ...(cfg.llm || {}), apiKey: '' },
    // 百度审核密钥、JWT 签名密钥、计费回传令牌同样不能下发给非管理员/访客
    moderation: {
      ...(cfg.moderation || {}),
      baidu: { ...(cfg.moderation?.baidu || {}), apiKey: '', secretKey: '' },
    },
    auth: {
      ...(cfg.auth || {}),
      sso: { ...(cfg.auth?.sso || {}), secret: '', publicKey: '' },
    },
    billing: { ...(cfg.billing || {}), reportToken: '' },
  };
}

export async function GET(req) {
  const cfg = loadConfig();
  // 公开模式或非管理员：不下发任何密钥；普通用户仍需 vision 等非敏感字段
  const isAdmin = isLocalAdmin(req);
  return NextResponse.json(PUBLIC_MODE || !isAdmin ? redactConfig(cfg) : cfg);
}

export async function PUT(req) {
  if (PUBLIC_MODE) {
    return NextResponse.json({ error: '公开模式下不允许通过接口修改配置' }, { status: 403 });
  }
  if (!isLocalAdmin(req)) {
    return NextResponse.json({ error: '需要管理员权限（请先登录管理员账号）' }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  // PUT 是整段覆盖：空对象 / 空请求体会把密钥与全部配置写成默认值。
  // 前端两个设置界面都会提交完整配置，所以这里拒绝明显错误的空载荷。
  const SECTIONS = ['server', 'comfyui', 'llm', 'hardware', 'generation', 'workflows', 'auth', 'billing', 'features', 'moderation', 'debug'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || !SECTIONS.some((k) => k in body)) {
    return NextResponse.json({ error: '配置内容为空，已拒绝写入' }, { status: 400 });
  }
  const saved = saveConfig(body);
  // auth.enabled / moderation.enabled 可能刚被改过：立即清缓存，不用等下一拍。
  resetAuthModeCache();
  resetModerationCache();
  return NextResponse.json(saved);
}
