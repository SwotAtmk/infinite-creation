import { normBaseUrl } from './utils.js';
import { logger } from './logger.js';

export function llmEndpoint(baseUrl) {
  let base = normBaseUrl(baseUrl || '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (!/\/v\d+$/.test(base)) base += '/v1';
  return base + '/chat/completions';
}

// 把 base64 dataURL 列表转成 OpenAI 多模态 image_url 内容块（视觉模型用）
export function imageUrlParts(dataUrls) {
  return (dataUrls || []).filter(Boolean).map((url) => ({ type: 'image_url', image_url: { url } }));
}

// 组装一条 user 消息：文本 + 可选图片；无图时保持纯字符串 content（兼容普通模型）
export function buildVisionUserMessage(text, dataUrls) {
  const parts = imageUrlParts(dataUrls);
  if (!parts.length) return { role: 'user', content: text };
  return { role: 'user', content: [{ type: 'text', text }, ...parts] };
}

// 把文本 + { data, mimeType } 图片列表转成 OpenClaude/Anthropic 内容块（供 openclaude SDK 初始消息投喂视觉模型）
export function buildVisionContentBlocks(text, images) {
  const blocks = [{ type: 'text', text }];
  for (const img of (images || [])) {
    if (img && img.data && img.mimeType) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } });
    }
  }
  return blocks;
}

export async function llmChat(llmCfg, messages, { json = false, tools = null, temperature = 0.8, maxTokens = 4000, timeoutMs = 180_000 } = {}) {
  if (!llmCfg?.apiKey) throw new Error('未配置 LLM api_key，请先到「设置」里配置。');
  const url = llmEndpoint(llmCfg.baseUrl);
  const body = { model: llmCfg.model, messages, temperature, max_tokens: maxTokens, stream: false };
  if (json) body.response_format = { type: 'json_object' };
  if (tools && tools.length) body.tools = tools;
  logger.debug('LLM 请求', { url, model: llmCfg.model, json, hasTools: !!(tools && tools.length) });
  // LLM 服务假死（TCP 挂着不响应）时无超时的 fetch 会永久 pending，JOB 永不结束。
  // 挂 AbortSignal.timeout：超时抛错给上层 catch，任务以 failed 收尾而非卡在 running。
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llmCfg.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e) => {
    // undici 连接失败只给 "fetch failed"，对用户毫无信息量 → 补上目标地址与排查提示
    throw new Error('无法连接 LLM（' + url + '），请确认 LLM 服务已启动、Base URL 正确。原始错误：' + (e?.message || e));
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('LLM 请求失败 ' + res.status + ': ' + text.slice(0, 500));
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text().catch(() => '');
    throw new Error('LLM 接口返回了非 JSON 内容（可能返回网页 HTML）。请检查 API Base URL 是否需以 /v1 结尾。返回开头：' + text.slice(0, 200));
  }
  const data = await res.json();
  const choice = data?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  logger.debug('LLM 响应', { content: String(message.content || '').slice(0, 2000), toolCalls: (message.tool_calls || []).length, finishReason: choice.finish_reason });
  return { content: message.content ?? '', toolCalls: message.tool_calls || [], finishReason: choice.finish_reason || '', message };
}

export function extractJson(text) {
  const cleaned = String(text || '').replace(/\u0060\u0060\u0060(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('LLM 返回内容不是合法 JSON：' + String(text || '').slice(0, 300));
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}
