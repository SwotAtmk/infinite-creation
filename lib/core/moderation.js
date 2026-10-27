// 内容安全审核：本地硬规则（同步，覆盖所有写库路径）+ LLM 语境审核（异步，覆盖 HTTP 写入与生成提交）。
// 目标：拦截露骨色情/裸露、血腥暴力、现实政治敏感、武器/恐怖教学、宗教极端内容；
// 虚构/历史背景下的战争、门派、信仰元素由 LLM 按语境放行。
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { llmChat } from './llm.js';
import { logger } from './logger.js';
import { CATEGORY_LABELS, EXTRA_BLOCK, FIELD_LABELS, HARD_BLOCK, NEVER_ALLOW } from './moderation-rules.js';

const cache = new Map();
const MAX_CACHE = 500;

// 配置优先、环境变量兜底：管理后台把 enabled/failClosed 写成布尔值后立即覆盖启动参数；
// null（未设置）时保持旧行为，跟随 IC_MODERATION / IC_MODERATION_FAIL_CLOSED。
export function resolveModerationEnabled(cfg, env = process.env) {
  if (typeof cfg?.moderation?.enabled === 'boolean') return cfg.moderation.enabled;
  return env.IC_MODERATION === '1';
}

// 文本审核：总开关关闭时必然关闭；总开关开启时由 moderation.text.enabled 决定（null=跟随总开关）
export function resolveTextModerationEnabled(cfg, env = process.env) {
  if (!resolveModerationEnabled(cfg, env)) return false;
  return typeof cfg?.moderation?.text?.enabled === 'boolean' ? cfg.moderation.text.enabled : true;
}

// 图片审核：总开关关闭时必然关闭；总开关开启时看百度审核的 enabled
export function resolveImageModerationEnabled(cfg, env = process.env) {
  if (!resolveModerationEnabled(cfg, env)) return false;
  return cfg?.moderation?.baidu?.enabled === true;
}

export function resolveModerationFailClosed(cfg, env = process.env) {
  if (typeof cfg?.moderation?.failClosed === 'boolean') return cfg.moderation.failClosed;
  return env.IC_MODERATION_FAIL_CLOSED === '1';
}

// 每个写请求都会问一次「审核开没开」：给 2 秒缓存，避免反复读 config.json。
let enabledCache = { at: 0, value: false };
export function resetModerationCache() {
  enabledCache = { at: 0, value: false };
}

export function textModerationEnabled() {
  const t = Date.now();
  if (t - enabledCache.at < 2000) return enabledCache.value;
  let v;
  try {
    v = resolveTextModerationEnabled(loadConfig());
  } catch {
    v = resolveTextModerationEnabled({}, process.env);
  }
  enabledCache = { at: t, value: v };
  return v;
}

export function moderationFailClosed() {
  try {
    return resolveModerationFailClosed(loadConfig());
  } catch {
    return process.env.IC_MODERATION_FAIL_CLOSED === '1';
  }
}

export class ContentBlockedError extends Error {
  constructor(category, reason, matched = []) {
    super('内容不合规（' + (CATEGORY_LABELS[category] || category || '其他') + '）：' + (reason || '包含不允许的内容'));
    this.name = 'ContentBlockedError';
    this.code = 'CONTENT_BLOCKED';
    this.category = category || 'other';
    this.matched = matched;
    this.status = 422;
  }
}

// 审核服务自身异常（模型超时/返回格式错误），不是内容命中。
// 必须和 ContentBlockedError 区分开：否则用户会以为自己的内容违规，反复改提示词也过不了。
export class ModerationUnavailableError extends Error {
  constructor(reason) {
    super('内容审核服务暂不可用：' + (reason || '请稍后重试'));
    this.name = 'ModerationUnavailableError';
    this.code = 'MODERATION_UNAVAILABLE';
    this.status = 503;
  }
}

function normalized(text) {
  return String(text == null ? '' : text).toLowerCase();
}

// 同步本地扫描：返回 { category, term } 或 null
export function localScan(text) {
  const s = normalized(text);
  if (!s.trim()) return null;
  for (const [category, terms] of Object.entries(HARD_BLOCK)) {
    for (const term of terms) {
      if (term && s.includes(normalized(term))) return { category, term };
    }
  }
  for (const term of EXTRA_BLOCK) {
    if (term && s.includes(normalized(term))) return { category: 'other', term };
  }
  return null;
}

// 零容忍扫描：儿童性内容不做语境判断，直接拦
export function neverScan(text) {
  const s = normalized(text);
  for (const [category, terms] of Object.entries(NEVER_ALLOW)) {
    for (const term of terms) {
      if (term && s.includes(normalized(term))) return { category, term };
    }
  }
  return null;
}

// 供 db 层同步调用：同步路径拿不到 LLM，只能拦零容忍项；
// 其余硬词只记录日志（作为线索），真正的语义判断交给异步审核（HTTP 写入 + 渲染提交前）。
export function assertSafeSync(fields, context = '') {
  if (!textModerationEnabled()) return;
  for (const [key, value] of Object.entries(fields || {})) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const never = neverScan(value);
    if (never) {
      logger.warn('内容拦截（零容忍）', { context, field: key, category: never.category, term: never.term });
      throw new ContentBlockedError(never.category, '命中「' + never.term + '」', [never.term]);
    }
    const hit = localScan(value);
    if (hit) logger.info('内容命中硬词（仅记录，交由语义审核判断）', { context, field: key, category: hit.category, term: hit.term });
  }
}

function cacheKey(field, text) {
  return field + ':' + crypto.createHash('sha1').update(String(text)).digest('hex');
}

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (v.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return v.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expires: Date.now() + 30 * 60_000 });
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

function parseJsonLoose(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function llmModerate(text, field, hint = null) {
  const cfg = loadConfig();
  if (!cfg?.llm?.baseUrl || !cfg?.llm?.apiKey) return { allow: true, skipped: 'llm-not-configured' };
  const clip = String(text).slice(0, 6000);
  const messages = [
    {
      role: 'system',
      content:
        '你是小说转视频平台的内容安全审核员。请**按整段文本的语义、语境和意图**判断，不要因为出现某个词就判违规。\n' +
        '只有内容在实质上达到下列程度才算违规：\n' +
        '1 sexual：露骨色情、明确的性行为描写、裸露性器官、对未成年人的性化；\n' +
        '2 violence：血腥肢解、虐待、详细的暴力伤害过程、自杀/自残方法；\n' +
        '3 political：现实政治敏感人物/事件、分裂国家、颠覆政权、政治宣传或煽动；\n' +
        '4 military：武器/爆炸物的制造教学、恐怖袭击、战争罪行宣扬、军事政变；\n' +
        '5 religious：宗教宣扬/传教、亵渎宗教、宗教仇恨、邪教。\n' +
        '判定原则：\n' +
        '- 虚构、历史、武侠、奇幻、艺术、医学、教育、新闻等语境下的相关词汇，如果没有露骨描写、不宣扬、不提供现实可操作细节，应放行。\n' +
        '- 「裸体雕塑」「血腥的战场」「战争场面」这类描述性、艺术性或叙事性表达不算违规。\n' +
        '- 判断对象是**未成年人**时从严：任何性化、诱惑化描写（包括暗示性的外貌/神态描写）都要拦截。\n' +
        '- 如果给你提供了「本地词表命中」提示，它只是线索，不是判定依据，请结合上下文自行判断。\n' +
        '只输出严格 JSON：{"allow":true|false,"category":"sexual|violence|political|military|religious|other|null","reason":"一句话原因"}',
    },
    {
      role: 'user',
      content:
        '字段：' + (FIELD_LABELS[field] || field || '文本') + '\n内容：\n' + clip
        + (hint ? '\n\n（本地词表提示：出现过「' + hint.term + '」。这只是线索，请按整段语义判断是否真的违规。）' : ''),
    },
  ];
  // 审核模型的输出额度必须留够推理空间：部分模型（如深推理变体）的思考过程也计入 max_tokens，
  // 只给 220 时会 finishReason=length、content 为空 → 解析失败 → 被误报成「内容不合规」。
  // 先在 512 下请求；仍是空/截断就提升到 1024 重试一次。
  const call = (maxTokens) => llmChat(cfg.llm, messages, { json: true, temperature: 0, maxTokens, timeoutMs: 20_000 });
  let resp = await call(512);
  let parsed = parseJsonLoose(resp?.content || '');
  if (!parsed && (resp?.finishReason === 'length' || !String(resp?.content || '').trim())) {
    logger.warn('审核模型输出为空/被截断，提升额度重试', { field, finishReason: resp?.finishReason });
    resp = await call(1024);
    parsed = parseJsonLoose(resp?.content || '');
  }
  if (!parsed || typeof parsed.allow !== 'boolean') {
    // 把原始返回记下来，否则「审核服务返回异常」永远查不到真正原因
    logger.warn('审核模型返回无法解析（非内容命中）', {
      field,
      finishReason: resp?.finishReason,
      content: String(resp?.content || '').slice(0, 300),
    });
    return { allow: false, category: 'other', reason: '审核服务返回格式异常，请稍后重试', error: 'BAD_RESPONSE', serviceError: true };
  }
  return { allow: !!parsed.allow, category: parsed.category || 'other', reason: String(parsed.reason || '') };
}

// 异步审核：本地规则 + LLM 语境判断。返回 {allow, category, reason, source}
export async function checkText(text, { field = 'text', useLlm = true } = {}) {
  if (!textModerationEnabled()) return { allow: true, source: 'disabled' };
  const value = String(text == null ? '' : text);
  if (!value.trim()) return { allow: true, source: 'empty' };

  // 零容忍项不做语境判断（儿童性内容）
  const never = neverScan(value);
  if (never) {
    logger.warn('内容拦截（零容忍）', { field, category: never.category, term: never.term });
    return { allow: false, category: never.category, reason: '命中「' + never.term + '」', source: 'hard', matched: [never.term] };
  }

  // 本地词表只作为「线索」：真正的违规判定由 LLM 按整段语义完成。
  const hit = localScan(value);

  // 无法调用 LLM 时只能保守处理：命中硬词就拦（避免词表成为摆设）
  if (!useLlm) {
    if (hit) {
      logger.warn('内容拦截（词表，无语义审核）', { field, category: hit.category, term: hit.term });
      return { allow: false, category: hit.category, reason: '命中「' + hit.term + '」', source: 'local', matched: [hit.term] };
    }
    return { allow: true, source: 'local' };
  }

  // 短文本且无词表线索：不值得为它调用模型
  if (!hit && value.trim().length < 8) return { allow: true, source: 'local' };

  const key = cacheKey(field, value);
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const result = await llmModerate(value, field, hit);
    // 没配置审核模型时，词表命中的内容按保守策略拦截；未命中则放行
    if (result.skipped === 'llm-not-configured' && hit) {
      return { allow: false, category: hit.category, reason: '命中「' + hit.term + '」（未配置语义审核模型，按词表保守拦截）', source: 'local', matched: [hit.term] };
    }
    if (!result.allow) {
      // 模型返回格式异常 ≠ 内容命中：按失败策略处理，不能伪装成 422 让用户以为内容违规。
      if (result.serviceError) {
        logger.warn('内容审核服务返回异常', { field, reason: result.reason });
        if (moderationFailClosed()) {
          return { allow: false, category: 'other', reason: '审核服务返回异常，请稍后重试', source: 'llm-error', serviceError: true };
        }
        return { allow: true, source: 'llm-error' };
      }
      logger.warn('内容拦截（LLM）', { field, category: result.category, reason: result.reason });
      const out = { allow: false, category: result.category || 'other', reason: result.reason || '内容不合规', source: 'llm' };
      cacheSet(key, out);
      return out;
    }
    const out = { allow: true, source: result.skipped || 'llm' };
    cacheSet(key, out);
    return out;
  } catch (e) {
    const failClosed = moderationFailClosed();
    logger.warn('内容审核 LLM 调用失败' + (failClosed ? '（已按 fail-closed 拦截）' : '（按本地规则放行）'), { field, error: e.message });
    if (failClosed) return { allow: false, category: 'other', reason: '内容审核服务暂不可用，请稍后重试', source: 'llm-error', serviceError: true };
    return { allow: true, source: 'llm-error' };
  }
}

// 批量审核对象里的文本字段，命中即抛 ContentBlockedError
export async function guardTexts(fields, { useLlm = true, context = '' } = {}) {
  if (!textModerationEnabled()) return { ok: true };
  for (const [key, value] of Object.entries(fields || {})) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const r = await checkText(value, { field: key, useLlm });
    if (!r.allow) {
      logger.warn('内容审核未通过', { context, field: key, category: r.category, reason: r.reason });
      if (r.serviceError) throw new ModerationUnavailableError(r.reason);
      throw new ContentBlockedError(r.category, r.reason, r.matched || []);
    }
  }
  return { ok: true };
}

// 前端/中间件用的检查：返回每个字段的结果，不抛错
export async function checkFields(fields, { useLlm = true } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (typeof value !== 'string' || !value.trim()) continue;
    out[key] = await checkText(value, { field: key, useLlm });
  }
  return out;
}
