// 可回滚变更日志 + 外部写入 API 的数据层测试。
//
// 这个文件必须在**临时数据目录**里跑：IC_DATA_DIR 要在首次 import lib/core 之前设好，
// 所以本文件一律用动态 import（静态 import 会被提升，环境变量来不及生效），
// 否则测试会直接写真实的 data/ic.db。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-changelog-'));
process.env.IC_DATA_DIR = TMP;

const core = await import('../lib/core/index.js');
const {
  Projects, Chapters, Shots, listChanges, countChanges, rollbackLogs,
  withWriteContext, rawGet, pickShotFields, DB_PATH,
} = core;

const findLog = (pid, pred) => listChanges(pid, { limit: 500 }).find(pred);
const shotLog = (pid, shotId, action = 'create') => findLog(pid, (l) => l.entity === 'shot' && l.entity_id === shotId && l.action === action);

// 临时库随进程结束清理（Windows 上库文件仍被占用时删不掉，忽略即可）
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

function mkProject(name) {
  // 生产代码里由路由包 writeContext；测试直接调用 db 层，这里手动包一层以验证 source/batch 记录
  return withWriteContext('test:create-project', () => Projects.create({ name }));
}

test('DB 落在临时目录（不碰真实 data/ic.db）', () => {
  assert.ok(DB_PATH.startsWith(TMP), DB_PATH);
});

test('建项目：项目 + 自动「第1章」各留一条 create 日志，同一批次', () => {
  const p = mkProject('日志项目A');
  const logs = listChanges(p.id, { limit: 20 });
  const proj = logs.find((l) => l.entity === 'project' && l.action === 'create');
  const chap = logs.find((l) => l.entity === 'chapter' && l.action === 'create');
  assert.ok(proj && chap, '应记录 project/chapter 两条 create');
  assert.equal(proj.before, null);
  assert.equal(proj.after.id, p.id);
  assert.equal(chap.after.title, '第1章');
  assert.equal(proj.batch_id, chap.batch_id);
  assert.equal(proj.source, 'test:create-project');
  Projects.remove(p.id);
});

test('写小说/剧本：chapter update 留档 before/after；无实质变化不记日志', () => {
  const p = mkProject('日志项目B');
  const cid = Chapters.list(p.id)[0].id;
  withWriteContext('test:write', () => Chapters.update(cid, { novel: '第一章原文……', script: '剧本：场景一' }));
  const log = findLog(p.id, (l) => l.entity === 'chapter' && l.entity_id === cid && l.action === 'update' && l.after.script === '剧本：场景一');
  assert.ok(log, '应记录章节 update');
  assert.equal(log.before.novel, '');
  assert.equal(log.after.script, '剧本：场景一');

  const before = countChanges(p.id);
  Chapters.update(cid, { novel: '第一章原文……' }); // 值未变
  assert.equal(countChanges(p.id), before, '无实质变化不应新增日志');
  Projects.remove(p.id);
});

test('流水线易变字段（status / video_path）不制造日志噪音', () => {
  const p = mkProject('日志项目C');
  const cid = Chapters.list(p.id)[0].id;
  const s = Shots.create(p.id, { chapter: '第1章', visual: '画面一' });
  const n = countChanges(p.id);
  Shots.update(s.id, { status: 'running' });
  Shots.update(s.id, { status: 'done', video_path: 'shots/a.mp4' });
  assert.equal(countChanges(p.id), n, '仅 status/产物字段变化不应记日志');
  Projects.remove(p.id);
});

test('单条回滚：回滚「新建分镜」= 删掉该分镜', () => {
  const p = mkProject('日志项目D');
  const s = Shots.create(p.id, { chapter: '第1章', visual: '画面一' });
  const log = shotLog(p.id, s.id, 'create');
  const res = rollbackLogs({ projectId: p.id, logId: log.id });
  assert.equal(res.blocked, false);
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].inverse, 'deleted');
  assert.equal(Shots.get(s.id), null);
  // 原日志被标记为已回滚，避免重复回滚
  assert.ok(findLog(p.id, (l) => l.id === log.id).reverted_by);
  Projects.remove(p.id);
});

test('单条回滚：回滚 update = 恢复旧值', () => {
  const p = mkProject('日志项目E');
  const s = Shots.create(p.id, { chapter: '第1章', visual: '旧画面' });
  withWriteContext('test:edit', () => Shots.update(s.id, { visual: '新画面', dialogue: '台词' }));
  const log = findLog(p.id, (l) => l.entity === 'shot' && l.entity_id === s.id && l.action === 'update');
  const res = rollbackLogs({ projectId: p.id, logId: log.id });
  assert.equal(res.applied[0].inverse, 'restored');
  assert.equal(Shots.get(s.id).visual, '旧画面');
  assert.equal(Shots.get(s.id).dialogue, '');
  Projects.remove(p.id);
});

test('整批回滚：删除章节（级联分镜）后可整体复原', () => {
  const p = mkProject('日志项目F');
  const c = Chapters.create(p.id, { title: '第2章', novel: '第二章原文' });
  const s1 = Shots.create(p.id, { chapter: '第2章', visual: '镜头1' });
  const s2 = Shots.create(p.id, { chapter: '第2章', visual: '镜头2' });
  const delId = withWriteContext('test:delete-chapter', () => {
    Chapters.remove(c.id);
    return listChanges(p.id, { limit: 1 })[0].batch_id; // 最近一批 = 这次删除
  });
  assert.equal(Chapters.get(c.id), null);
  assert.equal(Shots.get(s1.id), null);
  const res = rollbackLogs({ projectId: p.id, batchId: delId });
  assert.equal(res.blocked, false);
  assert.equal(res.applied.length, 3, '章节 + 两条级联分镜都要复原');
  assert.ok(Chapters.get(c.id), '章节应回来');
  assert.ok(Shots.get(s1.id) && Shots.get(s2.id), '级联删除的分镜应回来');
  assert.equal(Chapters.get(c.id).novel, '第二章原文');
  Projects.remove(p.id);
});

test('回滚的回滚 = 重做', () => {
  const p = mkProject('日志项目G');
  const s = Shots.create(p.id, { chapter: '第1章', visual: '画面' });
  const log = shotLog(p.id, s.id, 'create');
  rollbackLogs({ projectId: p.id, logId: log.id });              // 回滚：删掉
  assert.equal(Shots.get(s.id), null);
  const rb = findLog(p.id, (l) => l.action === 'rollback' && l.entity_id === s.id);
  rollbackLogs({ projectId: p.id, logId: rb.id });               // 回滚「回滚」：重做
  assert.ok(Shots.get(s.id), '重做后分镜应回来');
  assert.equal(Shots.get(s.id).visual, '画面');
  Projects.remove(p.id);
});

test('漂移保护：变更之后又被改过 → 拒绝回滚；force=true 才覆盖', () => {
  const p = mkProject('日志项目H');
  const s = Shots.create(p.id, { chapter: '第1章', visual: 'v1' });
  const createLog = shotLog(p.id, s.id, 'create');
  Shots.update(s.id, { visual: 'v2' });                          // 之后又改过
  const blocked = rollbackLogs({ projectId: p.id, logId: createLog.id });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.applied.length, 0, '有漂移时不应做任何改动');
  assert.equal(blocked.conflicts.length, 1);
  assert.ok(Shots.get(s.id), '被拒绝后分镜必须还在');
  const forced = rollbackLogs({ projectId: p.id, logId: createLog.id, force: true });
  assert.equal(forced.blocked, false);
  assert.equal(Shots.get(s.id), null);
  Projects.remove(p.id);
});

test('硬约束：回滚「项目创建」被跳过，项目不被删除', () => {
  const p = mkProject('日志项目I');
  const createLog = findLog(p.id, (l) => l.entity === 'project' && l.action === 'create');
  const res = rollbackLogs({ projectId: p.id, logId: createLog.id });
  assert.equal(res.applied.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /禁止删项目/);
  assert.ok(Projects.get(p.id), '项目必须还在');
  Projects.remove(p.id);
});

test('删除项目 → 变更日志级联清空（唯一自动清理时机）', () => {
  const p = mkProject('日志项目J');
  Chapters.list(p.id);
  Shots.create(p.id, { chapter: '第1章', visual: 'x' });
  assert.ok(countChanges(p.id) > 0);
  Projects.remove(p.id);
  assert.equal(countChanges(p.id), 0);
});

test('漂移只看内容字段：产物变化不阻挡回滚，且回滚保留产物', () => {
  const p = mkProject('日志项目K');
  const s = Shots.create(p.id, { chapter: '第1章', visual: 'v1' });
  const createLog = shotLog(p.id, s.id, 'create');
  Shots.update(s.id, { status: 'done', video_path: 'shots/a.mp4' }); // 流水线产物，不记日志
  const res = rollbackLogs({ projectId: p.id, logId: createLog.id });
  assert.equal(res.blocked, false, '只有产物字段变化不应判为漂移');
  assert.equal(Shots.get(s.id), null);
  assert.ok(res.applied[0].warning, '撤销新建时应提示磁盘产物文件仍在');

  // 撤销「文本改动」：内容回到旧值，但当前已渲染的产物字段必须保留
  const s2 = Shots.create(p.id, { chapter: '第1章', visual: '旧画面' });
  withWriteContext('test:edit', () => Shots.update(s2.id, { visual: '新画面' }));
  Shots.update(s2.id, { video_path: 'shots/b.mp4', status: 'done' });
  const upd = findLog(p.id, (l) => l.entity === 'shot' && l.entity_id === s2.id && l.action === 'update' && l.after.visual === '新画面');
  const r2 = rollbackLogs({ projectId: p.id, logId: upd.id });
  assert.equal(r2.blocked, false);
  const after = Shots.get(s2.id);
  assert.equal(after.visual, '旧画面', '内容应回到旧值');
  assert.equal(after.video_path, 'shots/b.mp4', '产物字段应被保留');
  assert.equal(after.status, 'done');
  Projects.remove(p.id);
});

test('pickShotFields：白名单外的字段一律报错，产物字段不可写', () => {
  const ok = pickShotFields({ visual: '画面', duration: 3.5, character_ids: ['a', '', 'b'], idx: 2 });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.patch.duration, 3.5);
  assert.deepEqual(ok.patch.character_ids, ['a', 'b']);
  assert.equal(ok.patch.idx, 2);

  const bad = pickShotFields({ status: 'done', video_path: 'x.mp4', visual: 'v' });
  assert.equal(bad.errors.length, 2);
  assert.equal(bad.patch.status, undefined);

  const wrongType = pickShotFields({ duration: 'abc', character_ids: 'a' });
  assert.equal(wrongType.errors.length, 2);
});
