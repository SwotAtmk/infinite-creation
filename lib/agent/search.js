// 联网搜索能力：文本/资料搜索（复用 multi-search-engine 技能脚本）+ 原生图片搜索 + SSRF 安全的图片下载。
//
// 定位：Agent 没有任何 shell 执行能力，技能脚本自己跑不了，所以这里用 execFile 拉 python3 跑技能；
// 图片搜索则用原生 fetch 抓百度/Bing 图片页（零依赖、无需 key），与技能「零依赖抓页面」的思路一致。
//
// downloadImageSafe 是本模块唯一的「下载任意外部 URL」入口，SSRF 防护必须内建在这里：
// 通过自定义 net.lookup 把连接钉在解析出的公网 IP 上（防 DNS rebinding），并拒绝一切内网/保留地址，
// 且对每个重定向逐跳重新校验。
import { execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { SKILLS_DIR, logger } from '../core/index.js';
import { REFERENCE_IMAGE_EXTS, REFERENCE_IMAGE_MAX_BYTES } from '../shared/index.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const IMAGE_MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

// ---------- 文本/资料搜索：复用已装技能 ----------

function runScript(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('python3', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// 文本/资料搜索。engine 省略时用国内引擎组合 --cn；返回 { query, items, engines_ok, engines_failed, error? }。
export async function searchWeb(query, opts = {}) {
  const q = String(query || '').trim();
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 8));
  const timeoutSec = Math.max(5, Math.min(120, Number(opts.timeoutSec) || 60));
  const args = [path.join(SKILLS_DIR, 'multi-search-engine', 'scripts', 'multi_search.py'), q, '--fetch', '--json', '--limit', String(limit)];
  const engine = String(opts.engine || '').trim();
  if (engine) args.push('--engines', engine);
  else args.push('--cn');
  // 默认 1.5s 间隔偏慢，压到 1s 兼顾礼貌节流与响应速度；单请求超时 8s 避免坏引擎卡住整次搜索。
  args.push('--delay', '1.0', '--timeout', '8');

  const { err, stdout, stderr } = await runScript(args, timeoutSec * 1000);
  // 脚本在「抓取模式且所有引擎失败且无结果」时返回非零退出，但 JSON 仍会打印到 stdout —— 照常解析。
  const parsed = parseJson(stdout);
  if (parsed) {
    return {
      query: parsed.query || q,
      items: (parsed.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet || '', engines: r.engines || [] })),
      engines_ok: parsed.engines_ok || [],
      engines_failed: parsed.engines_failed || [],
      result_count: parsed.result_count || 0,
    };
  }
  logger.warn('web_search 技能脚本未返回有效 JSON', { error: err?.message, stderr: stderr.slice(0, 300) });
  return { query: q, items: [], engines_ok: [], engines_failed: [], error: (err && err.message) || '搜索脚本未返回结果', stderr: stderr.slice(0, 500) };
}

// ---------- 图片搜索（原生，抓百度/Bing 图片页） ----------

function normalizeProtocol(u) {
  if (u.startsWith('//')) return 'https:' + u;
  return u.replace(/\\\//g, '/');
}

// 结果页里 JSON 是 HTML 实体编码的（&quot; → "），先解回来再按真实引号提取。
function decodeHtmlEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#x22;/g, '"').replace(/&amp;/g, '&');
}

function extractBingImages(html) {
  const out = [];
  const re = /"murl":"((?:https?:)?[^"]+)"/g;
  let m;
  const decoded = decodeHtmlEntities(html);
  while ((m = re.exec(decoded)) && out.length < 50) out.push({ image_url: normalizeProtocol(m[1]), thumbnail_url: '', source_url: '', title: '' });
  return out;
}

function extractBaiduImages(html) {
  const out = [];
  const re = /"objURL":"([^"]+)"/g;
  let m;
  const decoded = decodeHtmlEntities(html);
  while ((m = re.exec(decoded)) && out.length < 50) out.push({ image_url: normalizeProtocol(decodeURIComponentSafe(m[1])), thumbnail_url: '', source_url: '', title: '' });
  return out;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

// 图片搜索：返回图片 URL 数组（不下载）。{ query, items:[{image_url, thumbnail_url, source_url, title}], engines_ok, engines_failed }。
export async function searchImages(query, opts = {}) {
  const q = String(query || '').trim();
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10));
  const timeoutMs = Math.max(3, Math.min(30, Number(opts.timeoutSec) || 12)) * 1000;
  const engines = [
    { id: 'bing', url: 'https://cn.bing.com/images/search?q=' + encodeURIComponent(q) + '&form=HDRSC2', extract: extractBingImages },
    { id: 'baidu', url: 'https://image.baidu.com/search/index?tn=baiduimage&word=' + encodeURIComponent(q), extract: extractBaiduImages },
  ];
  const items = [];
  const seen = new Set();
  const ok = [];
  const failed = [];
  for (const e of engines) {
    try {
      const html = await fetchText(e.url, timeoutMs);
      const found = e.extract(html);
      ok.push(e.id);
      for (const f of found) {
        const key = f.image_url;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(f);
        if (items.length >= limit) break;
      }
    } catch (err) {
      failed.push({ engine: e.id, reason: (err && err.message) || String(err) });
    }
    if (items.length >= limit) break;
  }
  return { query: q, items: items.slice(0, limit), engines_ok: ok, engines_failed: failed };
}

// ---------- SSRF 安全下载 ----------

function isPrivateIpv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 畸形一律拒绝
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8、10/8、回环 127/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && p[2] === 2) return true; // TEST-NET-1 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试 198.18/15
  if (a === 198 && b === 51 && p[2] === 100) return true; // TEST-NET-2 198.51.100/24
  if (a === 203 && b === 0 && p[2] === 113) return true; // TEST-NET-3 203.0.113/24
  if (a >= 224) return true; // 组播/保留/广播
  return false;
}

function isPrivateIp(ip) {
  const s = String(ip || '').toLowerCase();
  if (!s) return true;
  if (s === '::1' || s === '::') return true;
  if (s.includes(':')) {
    if (s.startsWith('fc') || s.startsWith('fd')) return true; // 唯一本地 ULA fc00::/7
    if (/^fe[89ab]/.test(s)) return true; // 链路本地 fe80::/10
    const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpv4(mapped[1]);
    return false;
  }
  return isPrivateIpv4(s);
}

// 自定义 net.lookup：把连接钉在解析出的公网 IP 上，解析结果含内网/保留地址即拒绝。
// 注意 net 在两套契约下调用本函数：autoSelectFamily（默认开启）时会传 options.all=true，期望回调返回
// (err, [{address,family}...]) 地址数组；老路径期望 (err, address, family)。这里统一先解析全量并校验，再按需返回。
function makeSafeLookup() {
  return (hostname, options, callback) => {
    const wantAll = !!(options && options.all);
    dns.lookup(String(hostname), { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = (Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: (options && options.family) || 4 }])
        .filter((a) => a && a.address);
      if (!list.length) return callback(new Error('无法解析地址：' + hostname));
      if (list.some((a) => isPrivateIp(String(a.address)))) {
        return callback(new Error('SSRF：目标域名解析到内网/保留地址，已拒绝'));
      }
      if (wantAll) callback(null, list);
      else callback(null, String(list[0].address), list[0].family || 4);
    });
  };
}

function requestOnce(urlObj, { maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const mod = urlObj.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8', 'Accept-Encoding': 'identity' },
      lookup: makeSafeLookup(),
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.resume();
        resolve({ status, headers: res.headers, location: res.headers.location, body: null });
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error('下载失败：HTTP ' + status));
        return;
      }
      const cl = Number(res.headers['content-length'] || 0);
      if (cl > maxBytes) { res.destroy(); reject(new Error('图片超过大小限制（' + maxBytes + ' 字节）')); return; }
      const chunks = [];
      let size = 0;
      let aborted = false;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          aborted = true;
          res.destroy();
          reject(new Error('图片超过大小限制（' + maxBytes + ' 字节）'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => { if (!aborted) resolve({ status, headers: res.headers, location: res.headers.location, body: Buffer.concat(chunks) }); });
      res.on('error', (e) => reject(e));
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', (e) => reject(e));
    req.end();
  });
}

function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return '.gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
}

function mimeExt(contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  return IMAGE_MIME_EXT[base] || null;
}

// 下载一张图片，返回 { buffer, ext }。SSRF 防护：仅 http/https，逐跳重定向重新解析并拒绝内网/保留地址，
// 大小 ≤ REFERENCE_IMAGE_MAX_BYTES，并做 magic-byte 类型嗅探（白名单 png/jpg/jpeg/webp/gif）。
export async function downloadImageSafe(url, opts = {}) {
  const maxBytes = opts.maxBytes || REFERENCE_IMAGE_MAX_BYTES;
  const timeoutMs = opts.timeoutMs || 30000;
  let current = String(url || '');
  for (let i = 0; i < 5; i++) {
    let u;
    try { u = new URL(current); } catch { throw new Error('非法 URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https 图片地址');
    // 主机预检：IP 字面量时 Node 可能不走自定义 lookup，必须在这里直接判；域名走 requestOnce 里的 makeSafeLookup 再判。
    const host = String(u.hostname).replace(/^\[|\]$/g, '');
    if (host.toLowerCase() === 'localhost') throw new Error('SSRF：目标是内网地址，已拒绝');
    if (net.isIP(host) !== 0 && isPrivateIp(host)) throw new Error('SSRF：目标是内网/保留地址，已拒绝');
    const res = await requestOnce(u, { maxBytes, timeoutMs });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.location;
      if (!loc) throw new Error('重定向缺少 Location');
      current = new URL(loc, current).toString();
      continue;
    }
    const buffer = res.body;
    const byUrl = path.extname(u.pathname).toLowerCase();
    const ext = sniffImageExt(buffer) || (REFERENCE_IMAGE_EXTS.includes(byUrl) ? byUrl : mimeExt(res.headers['content-type']));
    if (!ext) throw new Error('下载内容不是受支持的图片（png/jpg/jpeg/webp/gif）');
    return { buffer, ext, contentType: String(res.headers['content-type'] || '') };
  }
  throw new Error('重定向次数过多');
}