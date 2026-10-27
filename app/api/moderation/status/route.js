// 审核状态（仅管理员）：返回总开关 / 文本 / 图片的「实际生效值」。
// 后台界面用它显示当前状态 —— 配置为 null 时实际值来自 IC_MODERATION，前端看不到环境变量。
import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/core/index.js';
import {
  resolveImageModerationEnabled,
  resolveModerationEnabled,
  resolveModerationFailClosed,
  resolveTextModerationEnabled,
} from '@/lib/core/moderation.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = loadConfig();
  const b = cfg.moderation?.baidu || {};
  const m = cfg.moderation || {};
  return NextResponse.json({
    total: resolveModerationEnabled(cfg),
    text: resolveTextModerationEnabled(cfg),
    image: resolveImageModerationEnabled(cfg),
    failClosed: resolveModerationFailClosed(cfg),
    imageReady: !!(b.apiKey && b.secretKey),
    configured: {
      total: typeof m.enabled === 'boolean' ? m.enabled : null,
      text: typeof m.text?.enabled === 'boolean' ? m.text.enabled : null,
      image: b.enabled === true,
      failClosed: typeof m.failClosed === 'boolean' ? m.failClosed : null,
    },
    env: {
      IC_MODERATION: process.env.IC_MODERATION === '1',
      IC_MODERATION_FAIL_CLOSED: process.env.IC_MODERATION_FAIL_CLOSED === '1',
    },
  });
}
