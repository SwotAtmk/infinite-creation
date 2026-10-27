// 计费对接：把渲染用量落到 usage_events，并可选回传父平台 / 提交前校验余额。
// 金额单位完全由后台配置（billing.currency + billing.prices），父平台只需按回传的 amount 扣金币。
import { loadConfig } from './config.js';
import { Usage, Wallet, WalletHolds, Projects } from './db.js';
import { logger } from './logger.js';
import { markJobPaused } from './pause.js';

const PRICE_KEY = {
  t2i: 'imagePerAsset',
  i2i: 'imagePerAsset',
  image: 'imagePerAsset',
  r2v: 'videoPerSecond',
  i2v: 'videoPerSecond',
  video: 'videoPerSecond',
  tts: 'ttsPerVoice',
  voice: 'ttsPerVoice',
  music: 'musicPerTrack',
  'llm-rewrite': 'llmRewritePerCall',
  rewrite: 'llmRewritePerCall',
  llm: 'llmPerChapter',
  'llm-chapter': 'llmPerChapter',
  export: 'exportPerChapter',
  assemble: 'exportPerChapter',
};

export function billingConfig(cfg) {
  return (cfg || loadConfig()).billing || {};
}

export function priceForKind(cfg, kind, quantity = 1) {
  const b = billingConfig(cfg);
  const key = PRICE_KEY[String(kind || '').toLowerCase()] || '';
  const unitPrice = key ? Number(b.prices?.[key]) || 0 : 0;
  const qty = Math.max(0, Number(quantity) || 0);
  const amount = Math.round(unitPrice * qty * 100) / 100;
  return { key, unitPrice, quantity: qty, amount, currency: b.currency || '点' };
}

// —— 本地积分钱包 ——
// 默认关闭，先在管理后台给账号充值并开启，避免升级后所有人生成被 0 余额挡住。
export function walletEnabled(cfg) {
  const b = billingConfig(cfg);
  return b.wallet?.enabled === true;
}

export class InsufficientCreditsError extends Error {
  constructor(detail) {
    const d = detail || {};
    super(
      '积分不足：需要 ' + (d.required != null ? d.required : '?') + ' ' + (d.currency || '点')
      + '，可用 ' + (d.available != null ? d.available : '?')
      + (d.balance != null ? '（余额 ' + d.balance + '，在途 ' + (d.held || 0) + '）' : ''),
    );
    this.name = 'InsufficientCreditsError';
    this.code = 'INSUFFICIENT_CREDITS';
    this.required = d.required;
    this.balance = d.balance;
    this.held = d.held;
    this.available = d.available;
    this.currency = d.currency;
  }
}

export function isInsufficientCredits(e) {
  return !!e && e.code === 'INSUFFICIENT_CREDITS';
}

export function getAccount(ownerId, cfg) {
  const b = billingConfig(cfg);
  const currency = b.currency || '点';
  if (!ownerId) {
    return { ownerId: '', balance: 0, held: 0, available: 0, total: 0, currency, todayUsed: 0, monthUsed: 0, projects: [], recent: [] };
  }
  const w = Wallet.ensure(ownerId, currency) || Wallet.get(ownerId);
  const nowTs = Date.now();
  const day = new Date(nowTs); day.setHours(0, 0, 0, 0);
  const month = new Date(nowTs); month.setDate(1); month.setHours(0, 0, 0, 0);
  const projects = Usage.sumByProject(ownerId, 0).map((x) => {
    let name = x.projectId;
    try { name = Projects.get(x.projectId)?.name || name; } catch { /* 项目已删 */ }
    return { ...x, name };
  });
  return {
    ownerId,
    balance: w?.balance || 0,
    held: w?.held || 0,
    available: w?.available != null ? w.available : (w?.balance || 0),
    total: w?.total || 0,
    currency: w?.currency || currency,
    todayUsed: Usage.sumSince(ownerId, day.getTime()),
    monthUsed: Usage.sumSince(ownerId, month.getTime()),
    projects,
    recent: Usage.list({ ownerId, limit: 20 }),
  };
}

/**
 * 提交前预授权（实点实扣）：从钱包余额立即扣除，成功 capture、失败 release。
 * 钱包关闭或金额为 0 时返回 null，调用方走原来的后付费/父平台逻辑。
 * 同一个 key 重复调用是幂等的：held 返回原 hold，captured 返回原 hold（capture 不会重复扣）。
 */
export function holdCredits({ ownerId, amount, key, jobId = '', projectId = '', kind = '', chapter = '', subject = '', ttlMs }, cfg) {
  const b = billingConfig(cfg);
  const cur = b.currency || '点';
  const amt = Math.round((Number(amount) || 0) * 100) / 100;
  if (!walletEnabled(cfg) || !ownerId || !(amt > 0)) return null;
  const existing = key ? WalletHolds.getByKey(key) : null;
  if (existing) {
    if (existing.status === 'released') throw Object.assign(new Error('预授权已释放，请重新提交'), { code: 'HOLD_RELEASED' });
    return existing;
  }
  const hold = WalletHolds.createHeld({
    ownerId, amount: amt, currency: cur, key, jobId, projectId, kind, chapter, subject, ttlMs,
  });
  if (!hold) {
    const w = Wallet.get(ownerId) || { balance: 0, held: 0, available: 0 };
    const err = new InsufficientCreditsError({ required: amt, balance: w.balance, held: w.held, available: w.available, currency: cur });
    // 渲染中的任务：标记暂停，让 Agent/批量循环停止继续提交后续步骤（已有产物保留）。
    if (jobId) markJobPaused(jobId, err.message);
    throw err;
  }
  if (jobId && !hold.jobId) WalletHolds.setJobId(hold.id, jobId);
  return hold;
}

/** 成功后把 hold 转成 usage；钱包关闭时返回 null，调用方回退 recordUsage。 */
export function captureHold(holdIdOrKey, { cfg, quantity, unitPrice, chapter, subject, note } = {}) {
  const key = holdIdOrKey && typeof holdIdOrKey === 'object' ? (holdIdOrKey.id || holdIdOrKey.key) : holdIdOrKey;
  if (!key) return null;
  const usage = WalletHolds.capture(key, { cfg, quantity, unitPrice, chapter, subject, note });
  if (usage) reportEvent(usage, cfg || loadConfig()).catch(() => {});
  return usage;
}

/** 失败/取消时释放预授权，余额退回。 */
export function releaseHold(holdIdOrKey, reason = '') {
  const key = holdIdOrKey && typeof holdIdOrKey === 'object' ? (holdIdOrKey.id || holdIdOrKey.key) : holdIdOrKey;
  if (!key) return null;
  return WalletHolds.release(key, reason);
}

export function topUpCredits(ownerId, amount, { note = '' } = {}) {
  return Wallet.credit(ownerId, amount, { type: 'topup', note });
}

export function attachHoldToJob(holdKey, jobId) {
  if (!holdKey || !jobId) return;
  const h = WalletHolds.getByKey(holdKey);
  if (h) WalletHolds.setJobId(h.id, jobId);
}

async function postJson(url, token, payload, timeoutMs = 8000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('HTTP ' + res.status + (j.error ? '：' + j.error : ''));
  return j;
}

/**
 * 提交前余额校验（可选）。约定：
 *   POST balanceUrl  { userId, amount, currency }
 *   → { ok: true } 或 { ok: false, balance } 或 { balance: number }
 * 未配置 balanceUrl / 未开启 enforceBalance 时直接放行。
 */
export async function checkBalance({ ownerId, amount, currency }, cfg) {
  const b = billingConfig(cfg);
  if (!b.enforceBalance || !b.balanceUrl || !(amount > 0)) return true;
  const j = await postJson(b.balanceUrl, b.balanceToken, { userId: ownerId, amount, currency });
  if (j.ok === false) throw new Error('余额不足：需要 ' + amount + ' ' + currency + (j.balance != null ? '，当前 ' + j.balance : ''));
  if (typeof j.balance === 'number' && j.balance < amount) {
    throw new Error('余额不足：需要 ' + amount + ' ' + currency + '，当前 ' + j.balance);
  }
  return true;
}

/**
 * 每日/每月额度（按用量表累计，0 = 不限制）。在提交前校验，超限直接拒绝。
 * 注意：多个请求并发时可能同时通过检查，属于可接受的近似（最终以用量记录为准）。
 */
export function checkQuota({ ownerId, amount, extraUsed = 0 }, cfg, nowTs = Date.now()) {
  const b = billingConfig(cfg);
  if (!ownerId || !(amount > 0)) return true;
  const currency = b.currency || '点';
  const reserved = Math.max(0, Number(extraUsed) || 0);
  const daily = Number(b.dailyLimit) || 0;
  if (daily > 0) {
    const d = new Date(nowTs);
    d.setHours(0, 0, 0, 0);
    const used = Usage.sumSince(ownerId, d.getTime()) + reserved;
    if (used + amount > daily) {
      throw new Error('今日额度不足：上限 ' + daily + ' ' + currency + '，已用/在途 ' + Math.round(used * 100) / 100 + '，本次需要 ' + amount);
    }
  }
  const monthly = Number(b.monthlyLimit) || 0;
  if (monthly > 0) {
    const m = new Date(nowTs);
    m.setDate(1);
    m.setHours(0, 0, 0, 0);
    const used = Usage.sumSince(ownerId, m.getTime()) + reserved;
    if (used + amount > monthly) {
      throw new Error('本月额度不足：上限 ' + monthly + ' ' + currency + '，已用/在途 ' + Math.round(used * 100) / 100 + '，本次需要 ' + amount);
    }
  }
  return true;
}

function usagePayload(item) {
  return {
    event: 'usage',
    userId: item.ownerId,
    projectId: item.projectId,
    jobId: item.jobId,
    kind: item.kind,
    chapter: item.chapter || '',
    subject: item.subject || '',
    holdId: item.holdId || '',
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    amount: item.amount,
    currency: item.currency,
    at: item.createdAt,
  };
}

function retryDelay(attempt) {
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempt - 1));
}

async function reportEvent(item, cfg) {
  const b = billingConfig(cfg);
  if (!b.reportUrl) return;
  try {
    await postJson(b.reportUrl, b.reportToken, usagePayload(item));
    Usage.markReported(item.id, '');
  } catch (e) {
    const max = Math.max(1, Number(b.reportRetryTimes) || 5);
    const attempts = (Number(item.reportAttempts) || 0) + 1;
    const next = attempts < max ? Date.now() + retryDelay(attempts) : 0;
    Usage.markReportFailed(item.id, e.message, next, attempts);
    logger.warn('用量回传失败（' + attempts + '/' + max + '）：' + e.message, { jobId: item.jobId, kind: item.kind });
  }
}

/**
 * 记录一次用量；配置了 reportUrl 时异步回传父平台。
 * unitPrice/currency 可显式传入——入队时快照的价格，避免长任务执行中改价影响记账。
 */
export async function recordUsage({ projectId, ownerId, jobId, kind, quantity, unitPrice, currency, chapter = '', subject = '', note = '' }, cfg) {
  const computed = priceForKind(cfg, kind, quantity);
  const qty = Math.max(0, Number(quantity) || 0);
  const unit = unitPrice == null ? computed.unitPrice : Number(unitPrice) || 0;
  const cur = currency || computed.currency;
  const amount = Math.round(unit * qty * 100) / 100;
  const item = Usage.add({ projectId, ownerId, jobId, kind, chapter, subject, note, quantity: qty, unitPrice: unit, amount, currency: cur });
  if (billingConfig(cfg).reportUrl) reportEvent(item, cfg).catch(() => {});
  return item;
}

/** 定时重试未回传的用量（由调度器每分钟调用一次）。 */
export async function retryPendingReports(cfg) {
  const b = billingConfig(cfg);
  if (!b.reportUrl) return;
  const items = Usage.pendingReports(Date.now(), 20);
  for (const item of items) await reportEvent(item, cfg);
}
