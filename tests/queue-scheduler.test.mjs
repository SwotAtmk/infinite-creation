// 渲染队列调度的公平性测试。
// 纯函数 planDispatch 直接测（不碰 DB）；数据库部分用临时 IC_DATA_DIR，绝不写真实 data/ic.db。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-queue-'));
process.env.IC_DATA_DIR = TMP;

const { planDispatch, poolOfKind } = await import('../lib/core/scheduler.js');
const { Queue, Jobs, Projects } = await import('../lib/core/db.js');
const { activeJobOfChapter, jobTouchesChapter } = await import('../lib/agent/job-runner.js');

const at = Date.now();
const item = (id, ownerId, pool = 'video', extra = {}) => ({
  id,
  ownerId,
  pool,
  priority: 0,
  seq: Number(String(id).replace(/\D/g, '')) || 0,
  enqueuedAt: at,
  ...extra,
});

test('单用户独占全部槽位', () => {
  const waiting = [1, 2, 3, 4, 5, 6].map((i) => item('a' + i, 'A'));
  const picked = planDispatch({ waiting, running: [], capacity: 4 });
  assert.equal(picked.length, 4);
  assert.ok(picked.every((p) => p.ownerId === 'A'));
});

test('两个用户平分 4 个槽位', () => {
  const waiting = [];
  for (let i = 1; i <= 10; i++) waiting.push(item('a' + i, 'A'));
  for (let i = 1; i <= 10; i++) waiting.push(item('b' + i, 'B'));
  const picked = planDispatch({ waiting, running: [], capacity: 4 });
  const by = picked.reduce((m, p) => ({ ...m, [p.ownerId]: (m[p.ownerId] || 0) + 1 }), {});
  assert.deepEqual(by, { A: 2, B: 2 });
});

test('5 个用户抢 4 个槽位：每人最多 1 个，不会有人垄断', () => {
  const waiting = [];
  for (const u of ['A', 'B', 'C', 'D', 'E']) for (let i = 1; i <= 20; i++) waiting.push(item(u + i, u));
  const picked = planDispatch({ waiting, running: [], capacity: 4 });
  assert.equal(picked.length, 4);
  assert.equal(new Set(picked.map((p) => p.ownerId)).size, 4);
});

test('批量提交不会饿死后来者：A 有 100 个，B 只有 1 个', () => {
  const waiting = [];
  for (let i = 1; i <= 100; i++) waiting.push(item('a' + i, 'A'));
  waiting.push(item('b1', 'B'));
  const picked = planDispatch({ waiting, running: [], capacity: 2 });
  assert.equal(picked.length, 2);
  assert.ok(picked.some((p) => p.ownerId === 'B'), 'B 的单个任务必须在本轮拿到槽位');
});

test('perUserConcurrency 是硬上限（可用于给单人限流）', () => {
  const waiting = [];
  for (let i = 1; i <= 10; i++) waiting.push(item('a' + i, 'A'));
  for (let i = 1; i <= 10; i++) waiting.push(item('b' + i, 'B'));
  const picked = planDispatch({ waiting, running: [], capacity: 4, perUserConcurrency: 1 });
  assert.equal(picked.length, 2);
  assert.deepEqual(picked.map((p) => p.ownerId).sort(), ['A', 'B']);
});

test('池保底：图片/视频各有积压时各拿一个', () => {
  const waiting = [item('v1', 'A', 'video'), item('i1', 'B', 'image')];
  const pools = { image: { min: 1, max: 0 }, video: { min: 1, max: 0 } };
  const picked = planDispatch({ waiting, running: [], capacity: 2, pools });
  assert.deepEqual(picked.map((p) => p.pool).sort(), ['image', 'video']);
});

test('池 max 限制生效，空出的槽位不会派给该池', () => {
  const waiting = [item('v1', 'A', 'video'), item('v2', 'B', 'video')];
  const pools = { video: { min: 0, max: 1 } };
  const picked = planDispatch({ waiting, running: [], capacity: 4, pools });
  assert.equal(picked.length, 1);
});

test('aging：等待过久的任务会提权，压过后来者', () => {
  const old = item('a9', 'A', 'video', { enqueuedAt: at - 20 * 60000, seq: 9 });
  const fresh = item('b1', 'B', 'video', { enqueuedAt: at - 1000, seq: 1 });
  const picked = planDispatch({ waiting: [fresh, old], running: [], capacity: 1, agingMs: 15 * 60000, at });
  assert.equal(picked[0].id, 'a9');
});

test('已在跑的用户不会继续抢空槽（按在线人数收缩份额）', () => {
  const running = [item('r1', 'A'), item('r2', 'A')];
  const waiting = [item('a3', 'A'), item('b1', 'B'), item('c1', 'C')];
  const picked = planDispatch({ waiting, running, capacity: 4 });
  assert.ok(picked.every((p) => p.ownerId !== 'A'), 'A 已经超过份额，本轮不应再拿');
});

test('poolOfKind：工作流 kind 映射到池', () => {
  assert.equal(poolOfKind('t2i'), 'image');
  assert.equal(poolOfKind('i2i'), 'image');
  assert.equal(poolOfKind('r2v'), 'video');
  assert.equal(poolOfKind('tts'), 'tts');
  assert.equal(poolOfKind('music'), 'music');
  assert.equal(poolOfKind('unknown'), 'render');
});

test('DB 队列：入队 → 领取 → 完成，状态与计数一致', () => {
  const a = Queue.enqueue({ jobId: 'j1', projectId: 'p1', ownerId: 'u1', pool: 'image', kind: 't2i' });
  const b = Queue.enqueue({ jobId: 'j1', projectId: 'p1', ownerId: 'u1', pool: 'video', kind: 'r2v' });
  assert.equal(Queue.countWaitingByOwner('u1'), 2);
  assert.ok(Queue.claim(a.id, 60000));
  assert.ok(!Queue.claim(a.id, 60000), '同一条目不能被领取两次');
  assert.ok(Queue.hasRunning('j1'));
  Queue.finish(a.id);
  assert.equal(Queue.hasRunning('j1'), false);
  assert.equal(Queue.countWaitingByOwner('u1'), 1);
  assert.ok(b.id);
});

test('DB 队列：停止任务时立即摘除等待条目', () => {
  const a = Queue.enqueue({ jobId: 'j2', ownerId: 'u2', pool: 'video', kind: 'r2v' });
  const b = Queue.enqueue({ jobId: 'j2', ownerId: 'u2', pool: 'video', kind: 'r2v' });
  const removed = Queue.cancelWaitingByJob('j2');
  assert.equal(removed.length, 2);
  assert.equal(Queue.get(a.id).status, 'cancelled');
  assert.equal(Queue.get(b.id).status, 'cancelled');
  assert.equal(Queue.countWaitingByOwner('u2'), 0);
});

test('DB 队列：多进程隔离（各自只看到自己入队的条目）', () => {
  const a = Queue.enqueue({ jobId: 'jw1', ownerId: 'u4', pool: 'video', workerId: 'w1' });
  const b = Queue.enqueue({ jobId: 'jw2', ownerId: 'u4', pool: 'video', workerId: 'w2' });
  const mine = Queue.waiting(Date.now(), 'w1');
  assert.ok(mine.some((x) => x.id === a.id));
  assert.ok(!mine.some((x) => x.id === b.id), '不能抢另一个进程的任务');
  assert.ok(Queue.running().length >= 0);
});

test('DB 队列：租约过期能被识别（执行器失联）', () => {
  const a = Queue.enqueue({ jobId: 'j3', ownerId: 'u3', pool: 'video', kind: 'r2v' });
  Queue.claim(a.id, 1000);
  const stale = Queue.staleRunning(Date.now() + 2000);
  assert.ok(stale.some((x) => x.id === a.id));
  Queue.fail(a.id, '执行器失联');
  assert.equal(Queue.get(a.id).status, 'failed');
});

// —— 渲染去重：流水线 + 手动点生成同时提交同一素材时，只能有一个任务 ——
test('同一 dedupeKey 的并发提交会被拒绝，避免重复渲染与重复扣费', () => {
  const a = Queue.enqueue({ jobId: 'd1', projectId: 'p1', ownerId: 'u1', pool: 'image', kind: 't2i', dedupeKey: 'asset:a1' });
  assert.ok(a && a.id);
  assert.throws(
    () => Queue.enqueue({ jobId: 'd2', projectId: 'p1', ownerId: 'u1', pool: 'image', kind: 't2i', dedupeKey: 'asset:a1' }),
    (e) => e && e.code === 'DUPLICATE_RENDER',
  );
  assert.equal(Queue.activeByDedupe('asset:a1')?.id, a.id);
});

test('不同 dedupeKey 互不影响', () => {
  const a = Queue.enqueue({ jobId: 'd3', projectId: 'p1', ownerId: 'u1', pool: 'image', kind: 't2i', dedupeKey: 'asset:b1' });
  const b = Queue.enqueue({ jobId: 'd4', projectId: 'p1', ownerId: 'u1', pool: 'image', kind: 't2i', dedupeKey: 'asset:b2' });
  assert.notEqual(a.id, b.id);
  Queue.finish(a.id); Queue.finish(b.id);
});

test('任务完成/取消后 dedupeKey 释放，可以再次提交', () => {
  const a = Queue.enqueue({ jobId: 'd5', projectId: 'p1', ownerId: 'u1', pool: 'image', kind: 't2i', dedupeKey: 'asset:c1' });
  Queue.finish(a.id);
  assert.equal(Queue.activeByDedupe('asset:c1'), null);
  const b = Queue.enqueue({ jobId: 'd6', projectId: 'p1', ownerId: 'u1', pool: 'image', kind: 't2i', dedupeKey: 'asset:c1' });
  assert.ok(b && b.id);
  Queue.cancel(b.id);
  assert.equal(Queue.activeByDedupe('asset:c1'), null);
});

// —— 多章节并行：项目级锁改成章节级锁 ——
test('jobTouchesChapter：只挡同一章；整项目任务挡全部章节；资源任务不挡章节', () => {
  const j = (type, cp) => ({ type, checkpoint: cp });
  assert.equal(jobTouchesChapter(j('create', { chapter: '第1章' }), '第1章'), true);
  assert.equal(jobTouchesChapter(j('create', { chapter: '第1章' }), '第2章'), false);
  assert.equal(jobTouchesChapter(j('stage', { chapter: '第2章' }), '第1章'), false);
  // 没有 chapter 的 create/stage = 整项目/全部章节
  assert.equal(jobTouchesChapter(j('create', {}), '第2章'), true);
  assert.equal(jobTouchesChapter(j('stage', {}), '第2章'), true);
  // 资产图/音色等资源级任务不阻塞章节
  assert.equal(jobTouchesChapter(j('asset-image', { subject: 'a1' }), '第2章'), false);
  assert.equal(jobTouchesChapter(j('voice-design', { subject: 'a1' }), '第2章'), false);
});

test('activeJobOfChapter：同项目不同章节互不阻塞', () => {
  const p = Projects.create({ name: '章节锁测试' });
  const j1 = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第1章' } });
  assert.ok(activeJobOfChapter(p.id, '第1章'));
  assert.equal(activeJobOfChapter(p.id, '第2章'), null);
  // 整项目任务（没有 chapter）挡所有章节
  const all = Jobs.create({ projectId: p.id, type: 'stage', checkpoint: {} });
  assert.ok(activeJobOfChapter(p.id, '第2章'));
  Jobs.update(j1.id, { status: 'done' });
  Jobs.update(all.id, { status: 'done' });
  assert.equal(activeJobOfChapter(p.id, '第2章'), null);
});

test('项目上下文按 key 合并：晚写的键不会覆盖早写的键', () => {
  const p = Projects.create({ name: '上下文合并测试' });
  // 模拟两个章节 Agent 各自读到旧快照后先后写不同键
  Projects.setContextKey(p.id, 'bible', '人物圣经');
  Projects.setContextKey(p.id, 'style', '风格指南');
  const got = Projects.get(p.id);
  assert.equal(got.context.bible, '人物圣经');
  assert.equal(got.context.style, '风格指南');
});
