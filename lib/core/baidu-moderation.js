// 百度智能云「图像内容审核」：只在「替换已有图片」时调用。
// 鉴权与接口地址都可在 config.json 的 moderation.baidu 里覆盖（默认走百度官方）。
import { loadConfig } from './config.js';
import { resolveModerationEnabled } from './moderation.js';

const DEFAULT_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const DEFAULT_CENSOR_URL = 'https://aip.baidubce.com/rest/2.0/solution/v1/img_censor/v2/user_defined';
const MAX_BYTES = 4 * 1024 * 1024; // 百度接口对图片体积的限制（base64 前）

let tokenCache = { token: '', expires: 0, apiKey: '' };

export function baiduConfig(cfg) {
  return (cfg || loadConfig())?.moderation?.baidu || {};
}

export function baiduEnabled(cfg) {
  const c = cfg || loadConfig();
  // 总开关关闭时图片审核也关闭；总开关开启时才看百度分项开关与密钥。
  if (!resolveModerationEnabled(c)) return false;
  const b = baiduConfig(c);
  return !!(b.enabled && b.apiKey && b.secretKey);
}

async function getAccessToken(cfg) {
  const b = baiduConfig(cfg);
  if (!b.apiKey || !b.secretKey) throw new Error('未配置百度 API Key / Secret Key');
  // 密钥变更后必须重新换 token：否则旧 token 会一直用到过期（最长 30 天）
  if (tokenCache.token && tokenCache.expires > Date.now() + 60_000 && tokenCache.apiKey === b.apiKey) return tokenCache.token;
  const base = b.tokenEndpoint || DEFAULT_TOKEN_URL;
  const url =
    base +
    (base.includes('?') ? '&' : '?') +
    'grant_type=client_credentials&client_id=' +
    encodeURIComponent(b.apiKey) +
    '&client_secret=' +
    encodeURIComponent(b.secretKey);
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000) });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error('百度鉴权失败：' + (j.error_description || j.error || ('HTTP ' + res.status)));
  const ttl = Number(j.expires_in) || 2592000;
  tokenCache = { token: j.access_token, expires: Date.now() + ttl * 1000, apiKey: b.apiKey };
  return tokenCache.token;
}

const TYPE_LABEL = { 0: '色情/低俗', 1: '暴恐', 2: '政治敏感', 3: '恶心不适' };

/**
 * 审核一张图片。返回 { ok:true } 或 { ok:false, reason }；
 * 服务/鉴权异常会 throw，由调用方按 failClosed 决定拦截还是放行。
 */
export async function baiduCensorImage(buf, cfg) {
  if (!baiduEnabled(cfg)) return { ok: true, skipped: true };
  if (!buf || !buf.length) return { ok: true, skipped: true };
  if (buf.length > MAX_BYTES) {
    return { ok: false, reason: '图片超过 4MB，无法送审（请压缩后再上传）' };
  }
  const b = baiduConfig(cfg);
  const token = await getAccessToken(cfg);
  const endpoint = b.endpoint || DEFAULT_CENSOR_URL;
  const url = endpoint + (endpoint.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
  const form = new URLSearchParams();
  // 百度 img_censor/v2/user_defined：base64 用 image，URL 用 imgUrl（不是 img）
  form.set('image', buf.toString('base64'));
  if (b.strategyId) form.set('strategyId', String(b.strategyId));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({}));
  if (j.error_code) throw new Error('百度审核失败：' + (j.error_msg || ('code=' + j.error_code)));
  if (!res.ok) throw new Error('百度审核请求失败：HTTP ' + res.status);
  const conclusion = String(j.conclusion || '');
  if (conclusion === '合规') return { ok: true, raw: j };
  const types = Array.isArray(j.data)
    ? [...new Set(j.data.map((d) => TYPE_LABEL[Number(d.type)]).filter(Boolean))]
    : [];
  const reason = types.length ? '命中 ' + types.join('、') : '图片未通过安全审核' + (conclusion ? '（' + conclusion + '）' : '');
  return { ok: false, reason, raw: j };
}

// 后台「测试连接」：只验证 Key/Secret 能否换到 access_token
export async function baiduTestConnection(cfg) {
  tokenCache = { token: '', expires: 0, apiKey: '' };
  await getAccessToken(cfg);
  return { ok: true };
}

export function resetBaiduTokenCache() {
  tokenCache = { token: '', expires: 0, apiKey: '' };
}
