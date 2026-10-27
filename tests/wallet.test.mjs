// 本地积分钱包：预授权 / 捕获 / 释放 / 并发不足 / 幂等。使用临时 SQLite，不碰真实 data/ic.db。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-wallet-'));
process.env.IC_DATA_DIR = TMP;

const { Wallet, WalletHolds, Usage } = await import('../lib/core/db.js');
const { holdCredits, captureHold, releaseHold, isInsufficientCredits } = await import('../lib/core/billing.js');
const { pausedReason, clearJobPaused } = await import('../lib/core/pause.js');

const cfg = {
  billing: {
    currency: '点',
    wallet: { enabled: true },
    prices: { imagePerAsset: 2, videoPerSecond: 0.5, llmPerChapter: 1, ttsPerVoice: 3, musicPerTrack: 5, exportPerChapter: 2, llmRewritePerCall: 0 },
  },
};
const owner = 'u-wallet';

test('钱包：预授权立即扣余额，捕获不重复扣，释放原路退回', () => {
  Wallet.credit(owner, 100, { note: 'test topup' });
  assert.equal(Wallet.get(owner).balance, 100);

  const h1 = holdCredits({ ownerId: owner, amount: 60, key: 'k1', kind: 'video', projectId: 'p1' }, cfg);
  assert.equal(Wallet.get(owner).balance, 40);
  assert.equal(Wallet.get(owner).held, 60);

  const h2 = holdCredits({ ownerId: owner, amount: 20, key: 'k2', kind: 'image', projectId: 'p1' }, cfg);
  assert.equal(Wallet.get(owner).balance, 20);
  releaseHold(h2.id, 'test release');
  assert.equal(Wallet.get(owner).balance, 40);
  assert.equal(Wallet.get(owner).held, 60);

  const usage = captureHold(h1.id, { cfg, quantity: 120, unitPrice: 0.5 });
  assert.ok(usage && usage.id);
  assert.equal(usage.amount, 60);
  assert.equal(Wallet.get(owner).balance, 40);
  assert.equal(Wallet.get(owner).held, 0);
});

test('钱包：余额不足拒绝预授权，并标记任务暂停（用于停止后续步骤）', () => {
  Wallet.credit(owner, 10, { note: 'topup' });
  assert.equal(Wallet.get(owner).balance, 50);
  let err = null;
  try {
    holdCredits({ ownerId: owner, amount: 60, key: 'k3', kind: 'video', projectId: 'p1', jobId: 'job-pause' }, cfg);
  } catch (e) {
    err = e;
  }
  assert.ok(isInsufficientCredits(err));
  assert.match(pausedReason('job-pause'), /积分不足/);
  clearJobPaused('job-pause');
  assert.equal(Wallet.get(owner).balance, 50);
});

test('钱包：同一个 key 幂等，重复捕获不会重复记用量', () => {
  Wallet.credit(owner, 20, { note: 'topup' });
  const before = Wallet.get(owner).balance;
  const a = holdCredits({ ownerId: owner, amount: 5, key: 'same-key', kind: 'image', projectId: 'p1' }, cfg);
  const b = holdCredits({ ownerId: owner, amount: 5, key: 'same-key', kind: 'image', projectId: 'p1' }, cfg);
  assert.equal(a.id, b.id);
  assert.equal(Wallet.get(owner).balance, before - 5);
  const count0 = Usage.list({ ownerId: owner, limit: 100 }).length;
  const u1 = captureHold('same-key', { cfg, quantity: 1 });
  const u2 = captureHold('same-key', { cfg, quantity: 1 });
  assert.equal(u1.id, u2.id);
  assert.equal(Usage.list({ ownerId: owner, limit: 100 }).length, count0 + 1);
});

test('钱包：在途金额统计正确，释放后归零', () => {
  const h = holdCredits({ ownerId: owner, amount: 7, key: 'held-check', kind: 'image', projectId: 'p1' }, cfg);
  assert.equal(WalletHolds.activeAmount(owner), 7);
  releaseHold(h.id);
  assert.equal(WalletHolds.activeAmount(owner), 0);
});
