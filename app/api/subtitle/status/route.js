// 字幕运行时的状态（设置页轮询）：Python 探测结果、venv 是否装好、两档模型是否已下载、后台任务进度。
import { NextResponse } from 'next/server';
import { subtitleStatus } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(subtitleStatus());
  } catch (e) {
    return NextResponse.json({ error: e.message || '读取字幕状态失败' }, { status: 500 });
  }
}
