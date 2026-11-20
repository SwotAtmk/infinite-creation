import { NextResponse } from 'next/server';
import { loadConfig, readLaunchState } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

// 开源版没有账号/管理后台：前端只需要功能开关与运行模式。
// launch：启动记录（首次启动时间 / 累计启动次数），前端据此在每次启动后弹一次问卷提示。
export async function GET() {
  let features = {};
  try {
    features = loadConfig()?.features || {};
  } catch {
    /* 配置读取失败时按默认全开处理 */
  }
  let launch = null;
  try {
    launch = readLaunchState();
  } catch {
    /* 启动记录读不到时前端不弹提示 */
  }
  return NextResponse.json({ features, launch });
}
