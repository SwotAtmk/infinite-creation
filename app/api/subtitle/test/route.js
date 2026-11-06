// 测试外部 audio2srt 服务：既测连通性，也判断对面是不是 audio2srt 的接口。
import { NextResponse } from 'next/server';
import { testSubtitleApi } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const PUBLIC_MODE = process.env.IC_PUBLIC === '1';

export async function POST(req) {
  if (PUBLIC_MODE) {
    return NextResponse.json({ error: '公开模式下不允许探测本机服务' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const baseUrl = String(body?.baseUrl || '');
  try {
    return NextResponse.json(await testSubtitleApi(baseUrl));
  } catch (e) {
    return NextResponse.json({ ok: false, compatible: false, error: e.message || '测试失败' }, { status: 500 });
  }
}
