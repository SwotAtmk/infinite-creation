// 渲染队列 + 本地钱包集成：入队前预扣、成功后转用量、余额不足不提交。
import test, { after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 调度器定时器是 unref 的；测试进程需要自己保持事件循环，才能等到队列发牌
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-wallet-queue-'));
process.env.IC_DATA_DIR = TMP;
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({
  comfyui: { provider: 'runninghub' },
  billing: { currency: '点', wallet: { enabled: true }, prices: { imagePerAsset: 2 } },
  generation: {
    queue: { enabled: true, capacity: 1, tickMs: 50, leaseMinutes: 1, retryTimes: 0, queueTimeoutMinutes: 1 },
    runninghubConcurrency: 1,
  },
}));
process.env.IC_CONFIG = CFG;

const { Projects, Wallet, Usage, Queue } = await import('../lib/core/db.js');
const { runInQueue } = await import('../lib/core/scheduler.js');
const { loadConfig } = await import('../lib/core/config.js');

const ownerId = 'u-queue';
const project = Projects.create({ name: 'wallet queue', owner_id: ownerId });

test('渲染队列：入队前预扣，成功后 capture 记用量', async () => {
  Wallet.credit(ownerId, 100, { note: 'test' });
  const r = await runInQueue(
    { projectId: project.id, ownerId, pool: 'image', kind: 't2i', quantity: 1 },
    async () => 'rendered',
  );
  assert.equal(r, 'rendered');
  const w = Wallet.get(ownerId);
  assert.equal(w.balance, 98);
  assert.equal(w.held, 0);
  const usage = Usage.list({ ownerId, limit: 10 });
  assert.equal(usage.length, 1);
  assert.equal(usage[0].amount, 2);
  assert.equal(Queue.activeByDedupe('asset:none'), null);
});

test('渲染队列：余额不足时不入队、不调用渲染', async () => {
  Wallet.credit(ownerId, -98, { note: '清零' }); // 余额 = 0
  let called = 0;
  await assert.rejects(
    () => runInQueue(
      { projectId: project.id, ownerId, pool: 'image', kind: 't2i', quantity: 1 },
      async () => { called++; return 'x'; },
    ),
    (e) => e && e.code === 'INSUFFICIENT_CREDITS',
  );
  assert.equal(called, 0);
  assert.equal(Wallet.get(ownerId).balance, 0);
});

test('渲染队列：渲染失败会 release 预授权', async () => {
  Wallet.credit(ownerId, 10, { note: 'topup' });
  const before = Wallet.get(ownerId).balance;
  await assert.rejects(
    () => runInQueue(
      { projectId: project.id, ownerId, pool: 'image', kind: 't2i', quantity: 1 },
      async () => { throw new Error('render failed'); },
    ),
    /render failed/,
  );
  assert.equal(Wallet.get(ownerId).balance, before);
  assert.equal(Wallet.get(ownerId).held, 0);
});

test('渲染队列：余额不足会标记任务暂停（Agent 停止后续步骤）', async () => {
  const { pausedReason, clearJobPaused } = await import('../lib/core/pause.js');
  Wallet.credit(ownerId, -Wallet.get(ownerId).balance, { note: '清零' });
  await assert.rejects(
    () => runInQueue(
      { jobId: 'pause-job', projectId: project.id, ownerId, pool: 'image', kind: 't2i', quantity: 1 },
      async () => 'x',
    ),
    (e) => e && e.code === 'INSUFFICIENT_CREDITS',
  );
  assert.match(pausedReason('pause-job'), /积分不足/);
  clearJobPaused('pause-job');
});

test('上游取消策略：charge_if_started 只对已开始的任务计费', async () => {
  const { providerBillable } = await import('../lib/core/runninghub.js');
  assert.equal(providerBillable('charge_if_started', { started: true }), true);
  assert.equal(providerBillable('charge_if_started', { started: false }), false);
  assert.equal(providerBillable('always_refund', { started: true }), false);
  assert.equal(providerBillable('always_charge', { started: false }), true);
  // 默认策略
  assert.equal(providerBillable('', { started: true }), true);
  assert.equal(providerBillable('', { started: false }), false);
});

test('渲染队列：上游已开始后取消仍 capture，不退预授权', async () => {
  Wallet.credit(ownerId, 10, { note: 'topup' });
  const before = Wallet.get(ownerId).balance;
  await assert.rejects(
    () => runInQueue(
      { projectId: project.id, ownerId, pool: 'image', kind: 't2i', quantity: 1 },
      async () => {
        const e = new Error('RunningHub 已开始，本地停止');
        e.code = 'PROVIDER_CANCELED';
        e.billable = true;
        throw e;
      },
    ),
    /RunningHub 已开始/,
  );
  assert.equal(Wallet.get(ownerId).balance, before - 2);
  assert.equal(Wallet.get(ownerId).held, 0);
  assert.ok(Usage.list({ ownerId, limit: 20 }).some((u) => u.amount === 2));
});
