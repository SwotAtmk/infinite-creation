// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { loadConfig, llmChat } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  // 优先测试前端输入框当前值（未保存状态），未传则回退到已保存配置
  let llmCfg = body?.llm;
  if (!llmCfg) {
    try { llmCfg = loadConfig().llm; } catch (e) { return NextResponse.json({ ok: false, error: '读取配置失败：' + e.message }); }
  }
  if (!llmCfg?.apiKey) return NextResponse.json({ ok: false, error: '未填写 API Key' });
  if (!llmCfg?.model) return NextResponse.json({ ok: false, error: '未填写模型' });
  try {
    const r = await llmChat(llmCfg, [{ role: 'user', content: 'ping' }], { maxTokens: 16, timeoutMs: 15000, temperature: 0 });
    return NextResponse.json({ ok: true, model: llmCfg.model, content: String(r.content || '').slice(0, 200) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message });
  }
}
