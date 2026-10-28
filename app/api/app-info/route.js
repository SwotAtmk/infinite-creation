import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

// 开源版没有账号/管理后台：前端只需要功能开关与运行模式。
export async function GET() {
  let features = {};
  try {
    features = loadConfig()?.features || {};
  } catch {
    /* 配置读取失败时按默认全开处理 */
  }
  return NextResponse.json({ features });
}
