import { NextResponse } from 'next/server';

// 内容审核中间件：对所有项目写入（创建项目、章节、素材、分镜、音乐、反馈等）做统一检查。
// 只处理 JSON 请求体；命中违规直接返回 422，不进入业务路由。
// 这里不直接 import Node 模块（middleware 跑在 Edge），而是调用后端的 /api/moderation/check。
const TEXT_FIELDS = [
  'name', 'title', 'novel', 'script', 'idea', 'style', 'description',
  'prompt', 'visual', 'dialogue', 'narration', 'sub_shots', 'video_prompt',
  'caption', 'lyrics', 'voice_desc', 'feedback', 'scene_name', 'camera',
  'bible', 'continuity',
];
// negative_prompt 不审核：正常反向提示词常含 nsfw/nude 等词。

const MAX_BODY = 8 * 1024 * 1024;

export async function middleware(req) {
  // 这里不再用 IC_MODERATION 提前短路：开关已改为管理后台可配置，
  // 由 /api/moderation/check 按当前配置判断（关闭时立即返回 allow）。
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return NextResponse.next();
  const contentType = String(req.headers.get('content-type') || '');
  if (!contentType.includes('application/json')) return NextResponse.next();
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return NextResponse.next();

  let body;
  try {
    body = await req.clone().json();
  } catch {
    return NextResponse.next();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.next();

  const fields = {};
  let total = 0;
  for (const key of TEXT_FIELDS) {
    const v = body[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    fields[key] = v;
    total += v.length;
    if (total > 200_000) break;
  }
  if (!Object.keys(fields).length) return NextResponse.next();

  const port = process.env.PORT || '4600';
  const origin = process.env.IC_INTERNAL_ORIGIN || 'http://127.0.0.1:' + port;
  try {
    const res = await fetch(origin + '/api/moderation/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IC-Internal': '1' },
      body: JSON.stringify({ fields }),
    });
    if (res.status === 422) {
      const data = await res.json().catch(() => ({}));
      return NextResponse.json(
        {
          error: data.reason ? '内容不合规：' + data.reason : '内容不合规',
          code: 'CONTENT_BLOCKED',
          category: data.category || 'other',
          field: data.field,
        },
        { status: 422 },
      );
    }
    if (!res.ok) {
      // check 路由只在「审核服务异常且策略为拦截」时返回 503；其余非 2xx 不阻断写入。
      if (res.status === 503) {
        return NextResponse.json({ error: '内容审核服务暂不可用，请稍后重试', code: 'MODERATION_UNAVAILABLE' }, { status: 503 });
      }
    }
    return NextResponse.next();
  } catch {
    if (process.env.IC_MODERATION_FAIL_CLOSED === '1') {
      return NextResponse.json({ error: '内容审核服务暂不可用，请稍后重试', code: 'MODERATION_UNAVAILABLE' }, { status: 503 });
    }
    return NextResponse.next();
  }
}

export const config = {
  matcher: ['/api/projects', '/api/projects/:path*'],
};
