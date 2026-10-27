import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireAgentSlot,
  agentConcurrency,
  agentQueueTimeoutMs,
  agentGateSnapshot,
  resetAgentGateForTest,
} from '../lib/agent/agent-gate.js';

test.afterEach(() => resetAgentGateForTest());
// 闸门内部定时器是 unref 的（不能拖住生产进程退出）；测试里用 ref 的定时器保持事件循环。
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

test('Agent 并发配置：默认 4，非法值回退，范围 1-32', () => {
  assert.equal(agentConcurrency({}), 4);
  assert.equal(agentConcurrency({ generation: { agentConcurrency: 0 } }), 4);
  assert.equal(agentConcurrency({ generation: { agentConcurrency: -3 } }), 4);
  assert.equal(agentConcurrency({ generation: { agentConcurrency: 2 } }), 2);
  assert.equal(agentConcurrency({ generation: { agentConcurrency: 99 } }), 32);
  assert.equal(agentQueueTimeoutMs({}), 120 * 60000);
  assert.equal(agentQueueTimeoutMs({ generation: { agentQueueTimeoutMinutes: 5 } }), 5 * 60000);
});

test('Agent 闸门：超过上限的任务排队，释放后按顺序放行', async () => {
  const release1 = await acquireAgentSlot({ limit: 1 });
  assert.deepEqual(agentGateSnapshot(), { active: 1, waiting: 0, limit: 1 });

  let secondStarted = false;
  const second = acquireAgentSlot({ limit: 1 }).then((release) => {
    secondStarted = true;
    return release;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(secondStarted, false);
  assert.equal(agentGateSnapshot().waiting, 1);

  release1();
  const release2 = await second;
  assert.equal(secondStarted, true);
  assert.equal(agentGateSnapshot().active, 1);
  release2();
  assert.equal(agentGateSnapshot().active, 0);
});

test('Agent 闸门：排队中停止会立即拒绝，不占槽位', async () => {
  const release = await acquireAgentSlot({ limit: 1 });
  let aborted = false;
  const waiting = acquireAgentSlot({ limit: 1, isAborted: () => aborted });
  aborted = true;
  await assert.rejects(waiting, (e) => e.code === 'AGENT_QUEUE_ABORTED');
  assert.equal(agentGateSnapshot().waiting, 0);
  release();
});

test('Agent 闸门：排队超时会拒绝，不占槽位', async () => {
  const release = await acquireAgentSlot({ limit: 1 });
  await assert.rejects(
    acquireAgentSlot({ limit: 1, waitMaxMs: 1000 }),
    (e) => e.code === 'AGENT_QUEUE_TIMEOUT',
  );
  assert.equal(agentGateSnapshot().waiting, 0);
  release();
});

test('Agent 闸门：多个等待者按 FIFO 放行', async () => {
  const release = await acquireAgentSlot({ limit: 1 });
  const order = [];
  const a = acquireAgentSlot({ limit: 1 }).then((r) => { order.push('a'); return r; });
  const b = acquireAgentSlot({ limit: 1 }).then((r) => { order.push('b'); return r; });
  await new Promise((r) => setTimeout(r, 20));
  release();
  const ra = await a;
  ra();
  const rb = await b;
  rb();
  assert.deepEqual(order, ['a', 'b']);
});
