// PostgreSQL 集成测试：默认跳过；设置 PG_TEST_URL 后运行。
//   PG_TEST_URL=postgres://ic:pass@127.0.0.1:55432/ic_test pnpm test
import test from 'node:test';
import assert from 'node:assert';

const url = process.env.PG_TEST_URL;

test('PostgreSQL 驱动：建表 / 事务 / 上下文合并 / 队列去重', { skip: !url && '未设置 PG_TEST_URL' }, async () => {
  process.env.IC_DB = 'postgres';
  process.env.DATABASE_URL = url;
  const { getDb, Projects, Assets, Chapters, Jobs, Queue, tx } = await import('../lib/core/index.js');
  const db = getDb();
  assert.equal(db.dialect, 'postgres');

  const p = Projects.create({ name: 'pg-test-' + Date.now() });
  try {
    assert.equal(Chapters.list(p.id).length, 1);
    Projects.setContextKey(p.id, 'bible', 'B');
    Projects.setContextKey(p.id, 'style', 'S');
    const ctx = Projects.get(p.id).context;
    assert.equal(ctx.bible, 'B');
    assert.equal(ctx.style, 'S');

    const a = Assets.create(p.id, { category: 'scene', name: 'pg scene', prompt: 'x' });
    const job = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第1章' } });
    const q = Queue.enqueue({
      jobId: job.id, projectId: p.id, ownerId: 'pg-user', pool: 'image', kind: 't2i',
      dedupeKey: 'asset:' + a.id, amount: 1.5, unitPrice: 1.5, currency: 'CNY',
    });
    assert.equal(q.amount, 1.5);
    assert.throws(
      () => Queue.enqueue({
        jobId: job.id, projectId: p.id, ownerId: 'pg-user', pool: 'image', kind: 't2i',
        dedupeKey: 'asset:' + a.id,
      }),
      (e) => e.code === 'DUPLICATE_RENDER',
    );
    Queue.finish(q.id);
    assert.equal(Queue.activeByDedupe('asset:' + a.id), null);

    assert.throws(() => tx(() => {
      Projects.create({ name: 'pg-rollback-' + Date.now() });
      throw new Error('boom');
    }), /boom/);

    const n = db.prepare('SELECT COUNT(*) n FROM projects WHERE id=?').get(p.id).n;
    assert.equal(n, 1);
  } finally {
    Projects.remove(p.id);
  }
});
