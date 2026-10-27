// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  // publicMode：前端据此隐藏管理员级设置（密钥、工作流、硬件适配、技能管理）。
  // 只暴露一个布尔值，不泄露任何配置内容。
  return NextResponse.json({ ok: true, publicMode: process.env.IC_PUBLIC === '1' });
}
