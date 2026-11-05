// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 作品集：跨项目汇总各创作类型（图片/视频/音乐/音色/数字人/秩影）的生成结果。
// 与 /api/projects 的区别：后者返回项目，这里返回项目里真正生成出来的素材。
import { NextResponse } from 'next/server';
import { Assets } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const url = new URL(req.url);
  const type = url.searchParams.get('type') || '';
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.max(1, Number(url.searchParams.get('pageSize')) || 60);
  return NextResponse.json(Assets.listWorks({ type, page, pageSize }));
}
