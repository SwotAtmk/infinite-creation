import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function uid() { return crypto.randomUUID(); }
export function now() { return Date.now(); }

export function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export function normBaseUrl(u) { return (u || '').replace(/\/+$/, ''); }

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function randomSeed() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

export function slugify(s) {
  return (s || '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'item';
}

// 图片文件 -> base64 dataURL（供视觉 LLM 投喂）。返回 { data, mimeType }；超大或未知类型返回 null。
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export function imageToDataUrl(absPath, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (!absPath) return null;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) return null;
    const mimeType = IMAGE_MIME[path.extname(absPath).toLowerCase()];
    if (!mimeType) return null;
    return { data: fs.readFileSync(absPath).toString('base64'), mimeType };
  } catch { return null; }
}

export async function withRetry(fn, { times = 3, delayMs = 3000, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < times - 1) {
        if (onRetry) onRetry(i + 1, e);
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}
