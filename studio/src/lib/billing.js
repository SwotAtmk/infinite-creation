// 费用提醒：价目表来自后台配置（/api/config 的 billing 段）。
// 只做展示估算；真正的扣费/用量回传由父平台负责（配置项已预留）。
import { useEffect, useState } from 'react';
import { api } from './api.js';

let cached = null;
let inflight = null;

// 后台保存配置后调用：清掉缓存，下一次进入项目页会重新拉取价目表。
export function invalidateBilling() {
  cached = null;
  inflight = null;
}

export function useBilling() {
  const [billing, setBilling] = useState(cached);
  useEffect(() => {
    if (cached) {
      setBilling(cached);
      return;
    }
    if (!inflight) {
      inflight = api
        .get('/api/config')
        .then((c) => (cached = c.billing || {}))
        .catch(() => (cached = {}));
    }
    let alive = true;
    inflight.then((v) => alive && setBilling(v || {}));
    return () => {
      alive = false;
    };
  }, []);
  return billing || {};
}

export function priceOf(billing, key) {
  return Number(billing?.prices?.[key]) || 0;
}

/** 数量 × 单价；未开启费用显示时返回空串。单价为 0 时明确显示「免费」，避免按钮悬停没有反馈。 */
export function costLabel(billing, key, qty = 1) {
  if (!billing?.showCost) return '';
  const price = priceOf(billing, key);
  const n = Number(qty) || 0;
  if (!n) return '';
  if (!price) return '免费';
  const v = Math.round(price * n * 100) / 100;
  return '约 ' + v + ' ' + (billing.currency || '点');
}

/** 单价（用于数量无法估算的节点，如视频按秒）。 */
export function costRate(billing, key, unit = '') {
  if (!billing?.showCost) return '';
  const price = priceOf(billing, key);
  if (!price) return '免费';
  return price + ' ' + (billing.currency || '点') + (unit ? '/' + unit : '');
}

/** 组合展示：有预估用预估，否则退回单价；都没有返回空串。 */
export function costText(billing, key, qty, unit = '') {
  return costLabel(billing, key, qty) || costRate(billing, key, unit);
}
