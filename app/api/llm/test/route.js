// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { loadConfig, llmChat } from '@/lib/core/index.js';
import { authEnabled, currentAuthUser } from '@/lib/core/auth.js';

export const dynamic = 'force-dynamic';

function canAdmin() {
  return !authEnabled() || currentAuthUser()?.role === 'admin';
}

export async function POST(req) {
  // 会用服务端保存的 LLM Key 发真实请求，只允许管理员
  if (!canAdmin()) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  // 优先测试前端输入框当前值（未保存状态），未传则回退到已保存配置
  let llmCfg = body?.llm;
  if (!llmCfg) {
    try { llmCfg = loadConfig().llm; } catch (e) { return NextResponse.json({ ok: false, error: '读取配置失败：' + e.message }); }
  }
  // 只要求 Base URL：本地无鉴权的 OpenAI 兼容端点（llama.cpp 等）没有 API Key 也能用。
  // 此前卡 apiKey，等于给这些用户的「测试连接」直接判负，而真实调用（llmChat）根本不需要它。
  if (!llmCfg?.baseUrl) return NextResponse.json({ ok: false, error: '未填写 API Base URL' });
  if (!llmCfg?.model) return NextResponse.json({ ok: false, error: '未填写模型' });
  try {
    const r = await llmChat(llmCfg, [{ role: 'user', content: 'ping' }], { maxTokens: 16, timeoutMs: 15000, temperature: 0 });
    return NextResponse.json({ ok: true, model: llmCfg.model, content: String(r.content || '').slice(0, 200) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message });
  }
}
