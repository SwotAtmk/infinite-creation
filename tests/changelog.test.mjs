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
const shared = await import('../lib/shared/index.js');
const { createToolRuntime, runTool, resolveShotProvisions, upsertMusicAsset } = await import('../lib/agent/tools.js');
const {
  Projects, Chapters, Shots, Assets, Jobs, listChanges, countChanges, rollbackLogs, getChange,
  withWriteContext, rawGet, pickShotFields, pickChapterFields, pickProjectFields, idxTakenBy, validateShotContent, tx, DB_PATH, chapterStats, projectDir,
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

// —— 以下为审计修复的回归：业务校验 / 标题唯一 / 事务 / since_ts 语义 / 章内镜号 ——
// 这些约束原先只在内置 Agent 的 set_storyboard、update_shot 里做，外部 API 直写会整条绕过，
// 结果是「写入合法、渲染阶段才炸」。测试盯着「写入点就拒绝」。

test('分镜业务校验：时长区间 / 镜号 / 分辨率与宽高比枚举', () => {
  assert.ok(pickShotFields({ duration: 60 }).errors.length, 'duration 超 15 秒应报错');
  assert.ok(pickShotFields({ duration: 0 }).errors.length, 'duration 低于 1 秒应报错');
  assert.ok(pickShotFields({ idx: 0 }).errors.length, 'idx < 1 应报错');
  assert.ok(pickShotFields({ idx: -3 }).errors.length, '负 idx 应报错');
  // 未在 workflow-specs 映射表里的值会原样写进 ComfyUI 参数，必须在写入口挡住
  assert.ok(pickShotFields({ resolution: 'banana' }).errors.length, '未映射的分辨率应报错');
  assert.ok(pickShotFields({ aspect_ratio: '5:4' }).errors.length, '非法宽高比应报错');
  assert.deepEqual(pickShotFields({ resolution: '' }).errors, [], '空串 = 继承项目设置，合法');
  assert.deepEqual(pickShotFields({ resolution: '720P', aspect_ratio: '9:16' }).errors, []);
  // 取值域来自 lib/shared（单一事实来源）：界面下拉给的、映射表能解析的，写接口都必须放行，
  // 否则会出现「界面里能选、写接口写不进」这种自相矛盾
  for (const v of shared.VIDEO_RESOLUTIONS) assert.deepEqual(pickShotFields({ resolution: v }).errors, [], v + ' 应可写');
  for (const r of shared.VIDEO_ASPECT_RATIOS) assert.deepEqual(pickShotFields({ aspect_ratio: r }).errors, [], r + ' 应可写');
  assert.ok(pickShotFields({ parent_shot_id: 'x' }).errors.length, '无人消费的 parent_shot_id 不再可写（无效字段）');
});

test('分辨率/宽高比：共享常量、工作流映射表、界面下拉三者不许再各写一份漂移', () => {
  const { VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTION_MP, VIDEO_RESOLUTION_OPTIONS, VIDEO_RESOLUTIONS } = shared;
  const gguf = core.DEFAULT_SPECS.find((s) => s.id === 'minimax_h3_r2v_gguf');
  assert.ok(gguf, '找不到 GGUF 视频规格');
  // 映射表就是共享常量本身（同一对象），键与值都不允许再分叉
  assert.deepEqual(gguf.roles.resolution.map, VIDEO_RESOLUTION_MP);
  // 宽高比映射表的键必须是共享列表的子集：多一处或少一处都会让某个方向「选了就报错」
  for (const k of Object.keys(gguf.roles.aspect_ratio.map)) {
    assert.ok(VIDEO_ASPECT_RATIOS.includes(k), k + ' 不在共享宽高比列表里');
  }
  // 下拉只给实测确认过的标签；映射表里多出来的（1080P/2K/4K）只用于兼容历史数据
  for (const v of VIDEO_RESOLUTION_OPTIONS) {
    assert.ok(VIDEO_RESOLUTIONS.includes(v), v + ' 出现在下拉里却没进可写集合');
  }
  // custom 不是查表值：它走 width/height 直写（见 tools.js 生成分支）
  assert.ok(VIDEO_RESOLUTIONS.includes('custom') && !VIDEO_RESOLUTION_MP.custom);
  assert.ok(VIDEO_RESOLUTION_MP['360P'] && VIDEO_RESOLUTION_MP['768P'], '下拉给的 360P/768P 必须在映射表里有条目');
});

test('项目级取值域：video_resolution / video_aspect_ratio 直写被拒（分镜整项目继承）', () => {
  // 这两项是分镜的回退上游（生成时取 shot.resolution || project.video_resolution）：写错不是
  // 「一个字段难看」，而是整个项目的每一镜都在渲染阶段才炸（标签查不到映射表就被原样写进 ComfyUI）。
  // 界面下拉只给合法值，但 PATCH /api/projects/:id 能直写 → 校验放在 db 层，UI/内置 Agent/外部 API 一并覆盖。
  assert.throws(() => Projects.create({ name: '脏分辨率', video_resolution: 'banana' }), (e) => e.code === 'BAD_PROJECT_ENUM');
  assert.throws(() => Projects.create({ name: '脏宽高比', video_aspect_ratio: '5:4' }), (e) => e.code === 'BAD_PROJECT_ENUM');
  const p = mkProject('项目枚举');
  assert.throws(() => Projects.update(p.id, { video_resolution: 'banana' }), (e) => e.code === 'BAD_PROJECT_ENUM');
  assert.throws(() => Projects.update(p.id, { video_aspect_ratio: '5:4' }), (e) => e.code === 'BAD_PROJECT_ENUM');
  assert.equal(Projects.get(p.id).video_resolution, '480P', '被拒的写入不许留下半截状态');
  // 空串 = 用默认：内置 Agent / 外部 harness 常把「没填」发成空串，不该因此 400
  assert.equal(Projects.update(p.id, { video_resolution: '', video_aspect_ratio: '' }).video_resolution, '480P');
  // 共享常量里的每个值都必须能写：包括不进下拉的 1080P/2K/4K（兼容历史）与 custom（走 width/height）
  for (const v of shared.VIDEO_RESOLUTIONS) {
    assert.equal(Projects.update(p.id, { video_resolution: v }).video_resolution, v, v + ' 应可写');
  }
  for (const r of shared.VIDEO_ASPECT_RATIOS) {
    assert.equal(Projects.update(p.id, { video_aspect_ratio: r }).video_aspect_ratio, r, r + ' 应可写');
  }
  // 只校验本次要写的键：存量行里的历史脏值不该把「改个名字」也堵死（否则老项目直接不可维护）
  core.getDb().prepare('UPDATE projects SET video_resolution = ? WHERE id = ?').run('banana', p.id);
  assert.equal(Projects.update(p.id, { name: '改个名字' }).name, '改个名字');
  assert.equal(Projects.get(p.id).video_resolution, 'banana', '没提这个字段就不动它');
  assert.equal(Projects.update(p.id, { video_resolution: '720P' }).video_resolution, '720P', '显式改正必须能写进去');
  Projects.remove(p.id);
});

test('合成顺序：按章节 seq → 章内 idx（多章整片不会交叉）', () => {
  const p = mkProject('多章顺序');
  const c1 = Chapters.list(p.id)[0];                       // 建项目时自动建「第1章」
  const c2 = Chapters.create(p.id, { title: '第2章' });
  const a1 = Shots.create(p.id, { chapter: c1.title, visual: '甲1' });
  const a2 = Shots.create(p.id, { chapter: c1.title, visual: '甲2' });
  const b1 = Shots.create(p.id, { chapter: c2.title, visual: '乙1' });
  const b2 = Shots.create(p.id, { chapter: c2.title, visual: '乙2' });
  assert.deepEqual([a1.idx, a2.idx, b1.idx, b2.idx], [1, 2, 1, 2], '每章独立镜号空间');
  // 旧口径「全局按 idx 排」会得到 甲1、乙1、甲2、乙2（两章 idx 都从 1 起）
  assert.deepEqual(Shots.listInNarrativeOrder(p.id).map((s) => s.visual), ['甲1', '甲2', '乙1', '乙2']);
  // 归属不到章节的历史脏数据排最后，不丢（b1 比 b2 早建，但因为找不到章节反而排在后面）
  Shots.update(b1.id, { chapter: '不存在的章' });
  assert.deepEqual(Shots.listInNarrativeOrder(p.id).map((s) => s.visual), ['甲1', '甲2', '乙2', '乙1']);
  Projects.remove(p.id);
});

test('分镜业务校验：台词速度按「真正落库的时长」算，说话人超 2 个拒绝', () => {
  // 10 秒上限 55 字（5.5 字/秒）
  assert.deepEqual(validateShotContent({ dialogue: '字'.repeat(50), duration: 10 }, {}), []);
  assert.ok(validateShotContent({ dialogue: '字'.repeat(60), duration: 10 }, {}).length, '60 字 / 10 秒超速');
  // 只改台词：上限要按行上已有时长算（而不是回落到默认 5 秒）
  assert.ok(validateShotContent({ dialogue: '字'.repeat(20) }, { duration: 2 }).length, '20 字 / 2 秒超速');
  assert.deepEqual(validateShotContent({ dialogue: '字'.repeat(20) }, { duration: 5 }), []);
  // 省略时长 → 与 Shots.create 的默认值（5 秒）一致
  assert.ok(validateShotContent({ dialogue: '字'.repeat(30) }, {}).length, '30 字 / 默认 5 秒超速');
  // 说话人：单镜最多 2 人（参考音色段数上限）
  assert.deepEqual(validateShotContent({ dialogue: '甲：看\n乙：走\n', duration: 5 }, {}), []);
  assert.ok(validateShotContent({ dialogue: '甲：看\n乙：走\n丙：停\n', duration: 5 }, {}).length, '3 个说话人应报错');
});

test('章节标题唯一：同项目重名（含只差空格）被拒绝', () => {
  const p = mkProject('标题唯一项目');
  assert.throws(() => Chapters.create(p.id, { title: '第1章' }), (e) => e.code === 'DUP_CHAPTER_TITLE', '与自动建的第1章重名');
  assert.throws(() => Chapters.create(p.id, { title: '第1章 ' }), (e) => e.code === 'DUP_CHAPTER_TITLE', 'trim 后重名也拒绝');
  const c2 = Chapters.create(p.id, { title: '第2章' });
  assert.throws(() => Chapters.update(c2.id, { title: '第1章' }), (e) => e.code === 'DUP_CHAPTER_TITLE', '改名撞上已有标题');
  // 改回自己的标题（含仅空格差异）不算冲突，其它字段照常写入
  Chapters.update(c2.id, { title: '第2章 ', novel: '第二章原文' });
  assert.equal(Chapters.get(c2.id).novel, '第二章原文');
  // 别的项目同名不受影响（唯一性只在项目内）
  const p2 = mkProject('标题唯一项目2');
  assert.ok(Chapters.create(p2.id, { title: '第2章' }));
  Projects.remove(p.id);
  Projects.remove(p2.id);
});

test('写入事务：中途抛错整体回滚，不留半吊子状态', () => {
  const p = mkProject('事务项目');
  const c = Chapters.create(p.id, { title: '第2章' });
  Shots.create(p.id, { chapter: '第2章', visual: '镜头1' });
  const n = countChanges(p.id);
  assert.throws(() => tx(() => {
    Chapters.remove(c.id);          // 多语句：章节 + 级联分镜
    throw new Error('boom');        // 之后失败
  }), /boom/);
  assert.ok(Chapters.get(c.id), '抛错后章节应回滚回来');
  assert.equal(Shots.list(p.id).filter((s) => s.chapter === '第2章').length, 1, '级联删除的分镜也应回滚回来');
  assert.equal(countChanges(p.id), n, '事务里的变更日志同样要撤销（否则日志与数据不一致）');
  Projects.remove(p.id);
});

test('since_ts 回滚不反转既有的回滚日志（否则等于悄悄重做）', () => {
  const p = mkProject('since 项目');
  const s = Shots.create(p.id, { chapter: '第1章', visual: 'v1' });
  const createLog = shotLog(p.id, s.id, 'create');
  rollbackLogs({ projectId: p.id, logId: createLog.id });        // 撤销新建 → 写一条 rollback 日志
  assert.equal(Shots.get(s.id), null);
  const rb = findLog(p.id, (l) => l.action === 'rollback' && l.entity_id === s.id);
  // 从 0 起回滚（窗口覆盖全部历史，含那条 rollback 日志）
  const res = rollbackLogs({ projectId: p.id, sinceTs: 0 });
  assert.equal(res.applied.filter((a) => a.original_action === 'rollback').length, 0, 'rollback 日志必须被 SQL 排除');
  assert.equal(Shots.get(s.id), null, '既有的回滚不能被反转成重做');
  assert.equal(findLog(p.id, (l) => l.id === rb.id).reverted_by, '', 'rollback 日志不该被标记为已回滚');
  Projects.remove(p.id);
});

test('整批回滚：窗口内「先建后删」同一行不被误判漂移（预检按执行顺序推演状态）', () => {
  const p = mkProject('误报项目');
  const s = Shots.create(p.id, { chapter: '第1章', visual: 'v1' });
  Shots.remove(s.id);                       // 同一窗口内又删掉：create 日志的 after 与「当前行」不再一致
  const res = rollbackLogs({ projectId: p.id, sinceTs: 0 });
  // 按真实执行顺序（ts DESC）推演：先撤销 delete（行回来）→ 再撤销 create（行删掉）→ 全程无冲突。
  // 若拿库里的真实状态做预检，create 那条会因为行已被删而误报 blocked=true。
  assert.equal(res.blocked, false, '不应因「窗口内先建后删」误判漂移');
  assert.equal(res.conflicts.length, 0);
  assert.equal(Shots.get(s.id), null, '先建后删净效果 = 不存在');
  Projects.remove(p.id);
});

test('Shots.create 自动镜号按章续号（每章独立 idx 空间）', () => {
  const p = mkProject('镜号项目');
  Chapters.create(p.id, { title: '第2章' });
  Shots.create(p.id, { chapter: '第1章', visual: 'a' });
  Shots.create(p.id, { chapter: '第1章', visual: 'b' });
  const s = Shots.create(p.id, { chapter: '第2章', visual: 'c' });
  assert.equal(s.idx, 1, '新章镜号应从 1 起，而不是接着项目级 MAX(idx)');
  assert.deepEqual(Shots.list(p.id).filter((x) => x.chapter === '第1章').map((x) => x.idx), [1, 2]);
  Projects.remove(p.id);
});

test('章节进度摘要：分镜「生成中」是 generating（历史 running 兼容）', () => {
  const p = mkProject('章节进度项目');
  assert.deepEqual(chapterStats(p.id, '第1章'), { total: 0, done: 0, status: 'empty' });
  const s = Shots.create(p.id, { chapter: '第1章', visual: '画面一' });
  assert.equal(chapterStats(p.id, '第1章').status, 'pending');
  // 分镜状态机（lib/shared 的 SHOT_STATUS）里用的是 generating；判 'running' 会让
  // 「正在出视频」的章节永远显示成「待生成」
  Shots.update(s.id, { status: 'generating' });
  assert.equal(chapterStats(p.id, '第1章').status, 'running');
  Shots.update(s.id, { status: 'running' }); // 历史库里可能存在的旧值
  assert.equal(chapterStats(p.id, '第1章').status, 'running');
  Shots.update(s.id, { status: 'done' });
  assert.deepEqual(chapterStats(p.id, '第1章'), { total: 1, done: 1, status: 'done' });
  Projects.remove(p.id);
});

test('叙事顺序：章节标题重复时分镜不翻倍（按标题取最小 seq）', () => {
  const p = mkProject('章名重复项目');
  const s1 = Shots.create(p.id, { chapter: '第1章', visual: 'a' });
  Chapters.create(p.id, { title: '第2章' });
  const s2 = Shots.create(p.id, { chapter: '第2章', visual: 'b' });
  // 模拟历史脏数据：直接塞一个与「第1章」同名的章节（Chapters.create 现在会拒绝重名）
  const t = Date.now();
  core.getDb().prepare('INSERT INTO chapters (id,project_id,title,novel,script,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('dup-' + p.id, p.id, '第1章', '', '', 9, 'pending', t, t);
  const order = Shots.listInNarrativeOrder(p.id).map((x) => x.id);
  assert.deepEqual(order, [s1.id, s2.id], '同名章节不得让同一条分镜在成片里出现两次');
  Projects.remove(p.id);
});

test('set_storyboard：章节必须存在（标题与 id 都认），不得写出孤儿分镜', async () => {
  const p = mkProject('分镜章节校验项目');
  const cid = Chapters.list(p.id)[0].id;
  const ctx = createToolRuntime({ projectId: p.id });
  // 未知章节：整批拒绝，且不留下任何分镜（校验在 clear 之前）
  await assert.rejects(
    () => runTool(ctx, 'set_storyboard', { shots: [{ chapter: '第9章', idx: 1, visual: '画面一' }] }),
    /章节不存在/,
  );
  assert.equal(Shots.list(p.id).length, 0);
  // 章节 id 也认（get_project/list_chapters 同时给出 id 与标题，模型传哪个都得对）
  await runTool(ctx, 'set_storyboard', { shots: [{ chapter: cid, idx: 1, visual: '画面一' }] });
  assert.deepEqual(Shots.list(p.id).map((s) => s.chapter), ['第1章']);
  // 缺 chapter 时回退到任务所在章节（ctx.chapter）
  const scoped = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  await runTool(scoped, 'set_storyboard', { shots: [{ idx: 2, visual: '画面二' }] });
  assert.deepEqual(Shots.list(p.id).map((s) => s.chapter), ['第1章', '第1章']);
  // 既没传 chapter 也不在章节任务里：拒绝（否则就是永不显示的孤儿分镜）
  await assert.rejects(
    () => runTool(ctx, 'set_storyboard', { shots: [{ idx: 3, visual: '画面三' }] }),
    /缺少 chapter/,
  );
  assert.equal(Shots.list(p.id).length, 2);
  Projects.remove(p.id);
});

test('set_storyboard：同批重复 (chapter, idx) 只落一条，镜号归一为 ≥1 整数', async () => {
  const p = mkProject('分镜同批去重项目');
  const ctx = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  await runTool(ctx, 'set_storyboard', { shots: [{ idx: 3, visual: '第一次' }, { idx: 3, visual: '第二次' }] });
  const shots = Shots.list(p.id);
  assert.equal(shots.length, 1, '同一 (chapter, idx) 视为同一个镜头，不能落两条');
  assert.equal(shots[0].idx, 3);
  assert.equal(shots[0].visual, '第二次', '同批后者覆盖前者（走到 update 分支）');
  // 小数镜号截断；同批里显式镜号参与「章内续号」，自动镜号不会与它撞号
  await runTool(ctx, 'set_storyboard', { shots: [{ idx: 4.7, visual: '小数' }, { visual: '自动续号' }] });
  assert.deepEqual(Shots.list(p.id).map((s) => s.idx).sort((a, b) => a - b), [3, 4, 5]);
  await assert.rejects(() => runTool(ctx, 'set_storyboard', { shots: [{ idx: 0, visual: 'x' }] }), /idx 必须是/);
  assert.equal(Shots.list(p.id).length, 3, '镜号非法时整批不写入');
  Projects.remove(p.id);
});

test('update_shot：时长归一化后才落库（越界裁剪、非数字拒绝）', async () => {
  const p = mkProject('分镜时长项目');
  const ctx = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  await runTool(ctx, 'set_storyboard', { shots: [{ idx: 1, visual: '画面一' }] });
  const id = Shots.list(p.id)[0].id;
  // 越界：裁剪到 1..15（与 set_storyboard 的 duration 口径一致），不是原值入库
  await runTool(ctx, 'update_shot', { shot_id: id, duration: -5 });
  assert.equal(Shots.get(id).duration, 1, '负时长不能原样落库（会以 seconds=-5 提交给 H3）');
  await runTool(ctx, 'update_shot', { shot_id: id, duration: 99 });
  assert.equal(Shots.get(id).duration, 15);
  // 非数字：拒绝，而不是把 '8秒' 写进 REAL 列
  await assert.rejects(() => runTool(ctx, 'update_shot', { shot_id: id, duration: '8秒' }), /duration 必须是数字/);
  assert.equal(Shots.get(id).duration, 15);
  Projects.remove(p.id);
});

test('update_shot：不得改写别的项目的分镜（归属校验）', async () => {
  const p1 = mkProject('归属校验甲');
  const p2 = mkProject('归属校验乙');
  const s2 = Shots.create(p2.id, { chapter: '第1章', visual: '乙项目的画面' });
  const ctx = createToolRuntime({ projectId: p1.id });
  await assert.rejects(() => runTool(ctx, 'update_shot', { shot_id: s2.id, visual: '被改掉' }), /分镜不存在/);
  assert.equal(Shots.get(s2.id).visual, '乙项目的画面', '别的项目的分镜不能被改');
  Projects.remove(p1.id);
  Projects.remove(p2.id);
});

test('自动换装：同章第二次换装事件不被首次结果误判为「已显式引用」', async () => {
  const p = mkProject('自动换装项目');
  const mkImg = (rel) => {
    const abs = path.join(projectDir(p.id), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
    return rel;
  };
  const ch = Assets.create(p.id, { category: 'character', name: '小明' });
  Assets.update(ch.id, { image_path: mkImg('assets/character/x.png') });
  // 预置一套「内容与提示词都没改过」的服装：change_outfit 判定可复用 → 直接返回，不触发渲染
  const costume = Assets.create(p.id, { category: 'costume', name: '小明-沐浴后换上的干净衣裳', description: '沐浴后换上的干净衣裳', prompt: 'keep', parent_id: ch.id });
  Assets.update(costume.id, { status: 'done', image_path: mkImg('assets/costume/y.png'), prompt_used: 'keep' });
  const reports = [];
  const ctx = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  ctx.report = (x) => reports.push(x);
  await runTool(ctx, 'set_storyboard', { shots: [
    { idx: 1, characters: ['小明'], visual: '小明在屋后沐浴' },
    { idx: 2, characters: ['小明'], visual: '小明又一次沐浴' },
  ] });
  const outfit = reports.find((r) => r.phase === '人物换装' && /套/.test(r.detail));
  assert.ok(outfit, '换装事件应被处理并上报');
  assert.match(outfit.detail, /2 套/, '第二次事件不能被首次自动绑定的服装当成「显式引用」而跳过');
  Projects.remove(p.id);
});

test('章节引用统一支持标题或 id（generate_chapter_videos / assemble_video）', async () => {
  const p = mkProject('章节引用项目');
  const c2 = Chapters.create(p.id, { title: '第2章' });
  // 第2章放一条「已出片且提示词未改过」的分镜：不需要重渲染，用来观察章节解析结果
  const s = Shots.create(p.id, { chapter: '第2章', visual: '画面' });
  Shots.update(s.id, { status: 'done', video_path: 'shots/v.mp4', video_prompt: 'p', video_prompt_used: 'p' });
  const ctx = createToolRuntime({ projectId: p.id });
  const r = JSON.parse(await runTool(ctx, 'generate_chapter_videos', { chapter: c2.id }));
  assert.equal(r.total, 1, '传章节 id 必须解析到该章（否则会静默返回「本章没有分镜」）');
  assert.equal(r.generated, 0);
  await assert.rejects(() => runTool(ctx, 'generate_chapter_videos', { chapter: '第9章' }), /章节不存在/);
  await assert.rejects(() => runTool(ctx, 'assemble_video', { chapter: '第9章' }), /章节不存在/);
  Projects.remove(p.id);
});

test('停止：当前分镜复位为待生成，不再留在「失败」', async () => {
  const p = mkProject('停止复位项目');
  const mkImg = (rel) => {
    const abs = path.join(projectDir(p.id), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
    return rel;
  };
  const ch = Assets.create(p.id, { category: 'character', name: '小明' });
  Assets.update(ch.id, { image_path: mkImg('assets/character/x.png') });
  const s = Shots.create(p.id, { chapter: '第1章', visual: '画面' });
  Shots.update(s.id, { video_prompt: '已完成的提示词', character_ids: [ch.id] });
  const ctx = createToolRuntime({ projectId: p.id });
  // 参考图能上传，但提交任务时 ComfyUI 不可达：让失败发生在「渲染的 try 内」（不起真进程）
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/upload/')) return new Response(JSON.stringify({ name: 'x.png', subfolder: '', type: 'input' }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error('模拟 ComfyUI 不可达');
  };
  // 渲染一开始就置位停止标记（模拟用户在第 1 镜渲染途中点停止）
  let aborted = false;
  ctx.isAborted = () => aborted;
  ctx.report = (x) => { if (x.phase === '分镜视频' && /^生成 /.test(x.detail || '')) aborted = true; };
  const calls = [];
  const orig = Shots.update;
  Shots.update = (id, f) => { calls.push({ id, f }); return orig.call(Shots, id, f); };
  let out;
  try {
    out = JSON.parse(await runTool(ctx, 'generate_chapter_videos', { chapter: '第1章' }));
  } finally { Shots.update = orig; globalThis.fetch = origFetch; }
  assert.equal(out.aborted, true);
  // 前提：渲染失败路径确实先把当前镜记成了 failed（否则这条测试没有验证到复位）
  assert.ok(calls.some((c) => c.id === s.id && c.f.status === 'failed'), '前提：渲染中先把当前镜记成 failed');
  assert.equal(Shots.get(s.id).status, 'pending', '停止后必须复位，方便直接重跑');
  assert.equal(Shots.get(s.id).error, '');
  Projects.remove(p.id);
});

test('save_context：key 值域与 schema/路由一致；continuity 文件损坏时自愈', async () => {
  const p = mkProject('上下文项目');
  const ctx = createToolRuntime({ projectId: p.id });
  await assert.rejects(() => runTool(ctx, 'save_context', { key: 'bible2', content: 'x' }), /key 只能是/);
  // 手改坏 continuity.json（非数组）：写入必须自愈，不能抛 TypeError
  const f = path.join(projectDir(p.id), 'context', 'continuity.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"oops": 1}');
  await runTool(ctx, 'save_context', { key: 'continuity', content: '第一条' });
  const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(Array.isArray(arr) && arr.length === 1 && arr[0].content === '第一条');
  Projects.remove(p.id);
});

test('generate_assets_batch：only 值域与 schema 一致（写错不能假装成功）', async () => {
  const p = mkProject('批量素材项目');
  const ctx = createToolRuntime({ projectId: p.id });
  await assert.rejects(() => runTool(ctx, 'generate_assets_batch', { only: ['video'] }), /only 只能是 image \/ tts/);
  Projects.remove(p.id);
});

test('Chapters.reorder：必须给出完整 id 集合，否则 seq 撞号', () => {
  const p = mkProject('章节排序项目');
  const a = Chapters.list(p.id)[0].id;
  const b = Chapters.create(p.id, { title: '第2章' }).id;
  const c = Chapters.create(p.id, { title: '第3章' }).id;
  // seq 是叙事顺序的唯一键：只给一部分会让没上榜的章节保留旧 seq
  assert.throws(() => Chapters.reorder(p.id, [c]), /排序需要包含全部章节/);
  assert.throws(() => Chapters.reorder(p.id, [a, a, b]), /重复/);
  assert.throws(() => Chapters.reorder(p.id, [a, 'nope', b]), /章节不存在/);
  assert.throws(() => Chapters.reorder(p.id, []), /缺少 ids/);
  // 合法排序：整批重排
  assert.equal(Chapters.reorder(p.id, [c, a, b]).count, 3);
  assert.deepEqual(Chapters.list(p.id).map((x) => x.title), ['第3章', '第1章', '第2章']);
  assert.deepEqual(Chapters.list(p.id).map((x) => x.seq), [1, 2, 3]);
  Projects.remove(p.id);
});

test('set_storyboard：未声明字段当场拒绝（字段拼错不再被静默丢弃）', async () => {
  const p = mkProject('分镜字段项目');
  const ctx = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  await assert.rejects(
    () => runTool(ctx, 'set_storyboard', { shots: [{ idx: 1, sence_name: '拼错的场景', cast: ['甲'] }] }),
    /未声明字段/,
  );
  // 拼错的批次不能留下空分镜
  assert.equal(Shots.list(p.id).length, 0, '被拒的批次必须一行都不写');
  // 正确字段照常写入
  await runTool(ctx, 'set_storyboard', { shots: [{ idx: 1, scene_name: '场景', visual: '画面' }] });
  const all = Shots.list(p.id);
  assert.equal(all.length, 1);
  assert.equal(all[0].scene_name, '场景');
  Projects.remove(p.id);
});

test('变更日志：seed 是流水线易变字段（渲染回写不刷日志、不阻塞内容回滚）', () => {
  const p = mkProject('seed 项目');
  // harness 风格的一次写入：共享 batch，便于之后整批回滚
  const s = withWriteContext('PUT /api/projects/:id/chapters/:cid/storyboard', () => Shots.create(p.id, { chapter: '第1章', visual: '画面' }));
  const createLog = listChanges(p.id, { entity: 'shot', action: 'create' }).find((l) => l.entity_id === s.id);
  const before = countChanges(p.id);
  // 模拟一次渲染回写：seed 换新随机值 + 流水线字段
  Shots.update(s.id, { seed: 987654, status: 'generating', video_path: 'shots/a.mp4', prompt_id: 'pid-1' });
  assert.equal(countChanges(p.id), before, '只改 seed/状态/产物路径不该产生内容日志');
  // 渲染回写后回滚那次内容写入：不该被判成漂移（seed 不是内容）
  const r = rollbackLogs({ projectId: p.id, batchId: createLog.batch_id });
  assert.equal(r.blocked, false, '渲染回写不该把内容回滚判成漂移');
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.applied.length, 1);
  assert.equal(Shots.get(s.id), null, '回滚后分镜应被删除');
  Projects.remove(p.id);
});

test('变更日志：total 与 items 同口径（entity/action/source 筛选一致）', () => {
  const p = mkProject('日志筛选项目');
  const s = withWriteContext('PUT /api/projects/:id/chapters/:cid/storyboard', () => Shots.create(p.id, { chapter: '第1章', visual: '画面' }));
  withWriteContext('PATCH /api/projects/:id/shots/:sid', () => Shots.update(s.id, { visual: '改后' }));
  const all = countChanges(p.id);
  const creates = listChanges(p.id, { entity: 'shot', action: 'create', limit: 500 });
  assert.ok(all >= 4, '项目/章节/分镜新建 + 分镜更新');
  assert.equal(countChanges(p.id), all, '不传筛选时不变');
  assert.equal(countChanges(p.id, { entity: 'shot', action: 'create' }), creates.length);
  assert.ok(countChanges(p.id, { entity: 'shot', action: 'create' }) < all, '筛选后的 total 必须小于全部（否则等于没筛）');
  const src = 'PATCH /api/projects/:id/shots/:sid';
  assert.equal(countChanges(p.id, { source: src }), listChanges(p.id, { source: src, limit: 500 }).length);
  assert.equal(countChanges(p.id, { entity: 'shot', action: 'create', source: src }), 0, '多条件是 AND');
  Projects.remove(p.id);
});

test('章节写入白名单：只认 title/novel/script，seq/status/music_* 当场拒绝', () => {
  const p = mkProject('章节白名单项目');
  const ch = Chapters.list(p.id)[0];
  // 允许的内容字段
  const ok = pickChapterFields({ title: '第1章', novel: '正文', script: '剧本' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.patch, { title: '第1章', novel: '正文', script: '剧本' });
  // 顺序键与流水线产物不可外部写入
  for (const k of ['seq', 'status', 'music_path', 'music_prompt', 'music_prompt_used', 'project_id', 'id']) {
    const r = pickChapterFields({ [k]: 'x' });
    assert.ok(r.errors.some((e) => e.includes(k)), k + ' 必须被拒：' + JSON.stringify(r.errors));
    assert.equal(r.patch[k], undefined);
  }
  // 拼错的字段不能静默通过（否则回 200 却什么都没改）
  assert.ok(pickChapterFields({ titel: '拼错' }).errors.length === 1);
  // 非对象请求体
  assert.deepEqual(pickChapterFields(null).errors, ['请求体必须是 JSON 对象']);
  // 值一律按字符串落库（与 Chapters.update 的 String 化口径一致）
  assert.deepEqual(pickChapterFields({ novel: 123 }).patch, { novel: '123' });
  // 允许字段真的能落库、且不动 seq
  const seqBefore = ch.seq;
  Chapters.update(ch.id, pickChapterFields({ script: '剧本正文' }).patch);
  assert.equal(Chapters.get(ch.id).script, '剧本正文');
  assert.equal(Chapters.get(ch.id).seq, seqBefore);
  Projects.remove(p.id);
});

test('idxTakenBy：按章判章内镜号占用（排除自身、非数字不拦、跨章互不影响）', () => {
  const p = mkProject('镜号占用项目');
  const c1 = Chapters.list(p.id)[0];
  const c2 = Chapters.create(p.id, { title: '第2章' });
  const a = withWriteContext('POST /api/projects/:id/shots', () => Shots.create(p.id, { chapter: c1.title, idx: 1, visual: 'A' }));
  const b = withWriteContext('POST /api/projects/:id/shots', () => Shots.create(p.id, { chapter: c1.title, idx: 2, visual: 'B' }));
  const c = withWriteContext('POST /api/projects/:id/shots', () => Shots.create(p.id, { chapter: c2.title, idx: 1, visual: 'C' }));
  const shots = Shots.list(p.id);
  assert.equal(idxTakenBy(shots, c1.title, 1)?.id, a.id, '同章同号算占用');
  assert.equal(idxTakenBy(shots, c1.title, '2')?.id, b.id, '字符串镜号按数字比');
  assert.equal(idxTakenBy(shots, c1.title, 3), null, '空闲镜号不算占用');
  assert.equal(idxTakenBy(shots, c1.title, 1, a.id), null, '排除自身（PATCH 保持原 idx 不该 400）');
  assert.equal(idxTakenBy(shots, c2.title, 1)?.id, c.id, '别的章同号互不影响');
  assert.equal(idxTakenBy(shots, c1.title, 'x'), null, '非数字不拦（由 pickShotFields 报 400）');
  Projects.remove(p.id);
});

test('validateShotContent：显式空 chapter 被拒（否则分镜从章节视图与统计里消失）', () => {
  assert.deepEqual(validateShotContent({ chapter: '第1章', visual: 'x' }, {}), []);
  assert.deepEqual(validateShotContent({ visual: 'x' }, {}), [], '省略 chapter 不在内容校验里报错（归属由调用方决定）');
  for (const v of ['', '   ']) {
    const errs = validateShotContent({ chapter: v, visual: 'x' }, {});
    assert.ok(errs.some((e) => e.includes('chapter 不能为空')), JSON.stringify(errs));
  }
});

test('activeJobOf：queued（排队中）也算活动任务，防重与 409 守卫不被绕过', async () => {
  const { activeJobOf } = await import('../lib/agent/job-runner.js');
  const p = mkProject('排队任务项目');
  const job = Jobs.create({ projectId: p.id, type: 'video' });
  assert.equal(activeJobOf(p.id)?.id, job.id, 'running 任务算活动');
  Jobs.update(job.id, { status: 'queued' });
  assert.equal(activeJobOf(p.id)?.id, job.id, 'queued 任务也必须算活动（否则可再起一条流水线/删掉它要写的行）');
  Jobs.update(job.id, { status: 'done' });
  assert.equal(activeJobOf(p.id), undefined, '结束后不再是活动任务');
  const other = mkProject('无任务项目');
  assert.equal(activeJobOf(other.id), undefined);
  Projects.remove(p.id);
  Projects.remove(other.id);
});

// 轮询等任务走到终态（running/queued 之外）
async function waitJob(id) {
  for (let i = 0; i < 250; i++) {
    const j = Jobs.get(id);
    if (j && j.status !== 'running' && j.status !== 'queued') return j.status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return (Jobs.get(id) || {}).status;
}

test('阶段任务：运行中被停止必须记 cancelled，不能让前端弹「任务完成」', async () => {
  const { startStageJob } = await import('../lib/agent/stages.js');
  const { stopJob } = await import('../lib/agent/job-runner.js');
  const p = mkProject('阶段停止项目');
  const job = startStageJob({ projectId: p.id, stages: ['image'] });
  // 立刻停止：runExclusiveVideo 用微任务启动 fn，此刻 run() 还没拿到控制权，
  // 必然走「阶段循环开头的 isAborted 检查 → 正常 resolve」这条路（正是原先被记成 done 的那条）。
  stopJob(job.id);
  assert.equal(await waitJob(job.id), 'cancelled', '被停止的阶段任务记 done 会让前端弹「✅ 任务完成」，而后面几章根本没跑');
  Projects.remove(p.id);
});

test('回滚「章节新建」：级联删的分镜逐条留 delete 日志，重做能把章节与分镜一起恢复', () => {
  const p = mkProject('章节回滚级联项目');
  const ch = withWriteContext('POST /api/projects/:id/chapters', () => Chapters.create(p.id, { title: '待撤章节' }));
  const s1 = withWriteContext('PUT /api/projects/:id/chapters/:cid/storyboard', () => Shots.create(p.id, { chapter: '待撤章节', idx: 1, visual: 'A' }));
  const s2 = withWriteContext('PUT /api/projects/:id/chapters/:cid/storyboard', () => Shots.create(p.id, { chapter: '待撤章节', idx: 2, visual: 'B' }));
  const chCreate = listChanges(p.id, { entity: 'chapter', action: 'create', limit: 500 }).find((l) => l.entity_id === ch.id);
  assert.ok(chCreate?.batch_id, '章节 create 日志应有批次');
  // 撤销章节新建 → 级联删该章 2 条分镜
  const r = rollbackLogs({ projectId: p.id, batchId: chCreate.batch_id });
  assert.equal(r.blocked, false);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].chapter_shots_deleted, 2, '级联删条数应上报');
  assert.equal(Chapters.get(ch.id), null, '章节已删');
  assert.equal(Shots.list(p.id).length, 0, '分镜已随章节级联删除');
  // 级联删必须留痕（否则审计看不到、重做也恢复不了）
  const cascaded = listChanges(p.id, { entity: 'shot', action: 'delete', limit: 500 }).filter((l) => l.meta?.cascade === 'chapter-rollback');
  assert.deepEqual(cascaded.map((l) => l.entity_id).sort(), [s1.id, s2.id].sort(), '两条分镜各有一条 delete 日志');
  assert.ok(cascaded.every((l) => l.before?.id && l.batch_id === cascaded[0].batch_id), '日志带原始行快照、同属本次回滚批次');
  // 重做：回滚这次回滚（按它自己的批次）→ 章节与分镜都要回来
  const redo = rollbackLogs({ projectId: p.id, batchId: cascaded[0].batch_id });
  assert.equal(redo.blocked, false, '重做不应被漂移保护挡住');
  const back = Chapters.get(ch.id);
  assert.ok(back && back.title === '待撤章节', '章节恢复');
  const shots = Shots.list(p.id).sort((a, b) => a.idx - b.idx);
  assert.deepEqual(shots.map((s) => s.id), [s1.id, s2.id].sort((a, b) => (a === s1.id ? -1 : 1)), '两条分镜都恢复');
  assert.deepEqual(shots.map((s) => s.idx), [1, 2]);
  assert.ok(shots.every((s) => s.chapter === '待撤章节' && s.visual === 'A' || s.visual === 'B'), '内容与归属原样恢复');
  Projects.remove(p.id);
});

test('force 回滚「行已不存在」的日志：仍留审计记录并打上 reverted_by', () => {
  const p = mkProject('审计兜底项目');
  const s = withWriteContext('POST /api/projects/:id/shots', () => Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'A' }));
  const createLog = listChanges(p.id, { entity: 'shot', action: 'create', limit: 500 }).find((l) => l.entity_id === s.id);
  assert.ok(createLog?.id);
  // 该行先被别处删掉，之后才来 force 回滚这条 create：两侧都没有行可归属
  withWriteContext('DELETE /api/projects/:id/shots/:sid', () => Shots.remove(s.id));
  const r = rollbackLogs({ projectId: p.id, logId: createLog.id, force: true });
  assert.equal(r.applied.length, 1);
  assert.ok(r.applied[0].rollback_log_id, 'force 回滚也必须写出 rollback 审计记录');
  assert.equal(getChange(createLog.id).reverted_by, r.applied[0].rollback_log_id, 'reverted_by 指向本次回滚日志');
  // 之后的全量回滚不该再把这条 create 当「未回滚」重撤一次
  const again = rollbackLogs({ projectId: p.id, sinceTs: createLog.ts, force: true });
  assert.equal(again.applied.some((a) => a.log_id === createLog.id), false, '已回滚的日志不再被重复撤销');
  assert.ok(again.skipped.some((x) => x.log_id === createLog.id && x.reason === '已被回滚'), '应报告为已回滚跳过');
  Projects.remove(p.id);
});

test('Assets.usageOf：能看出子变体与被分镜引用（用途切换/删除前的前置检查）', () => {
  const p = mkProject('素材占用项目');
  const ch = withWriteContext('POST /api/projects/:id/assets', () => Assets.create(p.id, { category: 'character', name: '甲' }));
  const costume = withWriteContext('POST /api/projects/:id/assets', () => Assets.create(p.id, { category: 'costume', name: '甲-礼服', parent_id: ch.id }));
  const prop = withWriteContext('POST /api/projects/:id/assets', () => Assets.create(p.id, { category: 'prop', name: '剑' }));
  assert.deepEqual(Assets.usageOf(ch.id), { children: 1, shotIds: [] }, '角色挂着 1 个服装变体');
  assert.deepEqual(Assets.usageOf(prop.id), { children: 0, shotIds: [] }, '没被引用的道具干净');
  const s = withWriteContext('PUT /api/projects/:id/chapters/:cid/storyboard', () => Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'A', character_ids: [ch.id], costume_ids: [costume.id] }));
  assert.deepEqual(Assets.usageOf(ch.id), { children: 1, shotIds: [s.id] });
  assert.deepEqual(Assets.usageOf(costume.id), { children: 0, shotIds: [s.id] }, '变体本身无子，但有分镜引用');
  Shots.update(s.id, { audio_ids: [prop.id] });
  assert.deepEqual(Assets.usageOf(prop.id), { children: 0, shotIds: [s.id] }, 'audio_ids 里的引用同样算占用');
  Shots.remove(s.id);
  assert.deepEqual(Assets.usageOf(ch.id), { children: 1, shotIds: [] }, '分镜删掉后不再算被引用');
  Projects.remove(p.id);
});

test('回滚：不存在的 log_id/batch_id 报错，不假装「回滚成功」', () => {
  const p = mkProject('回滚空目标项目');
  assert.throws(() => rollbackLogs({ projectId: p.id, logId: 'nope' }), (e) => e.code === 'BAD_TARGET', 'log_id 不存在 → BAD_TARGET');
  assert.throws(() => rollbackLogs({ projectId: p.id, batchId: 'nope' }), (e) => e.code === 'BAD_TARGET', 'batch_id 不存在 → BAD_TARGET');
  // 本项目存在的 log_id 但要撤的行已不属于本项目：仍按「查不到」处理
  const other = mkProject('回滚空目标项目2');
  const logOfOther = listChanges(other.id, { limit: 500 })[0];
  assert.throws(() => rollbackLogs({ projectId: p.id, logId: logOfOther.id }), (e) => e.code === 'BAD_TARGET', '别的项目的日志 → BAD_TARGET');
  // since_ts 没有内容变更是合法空结果，不报错
  const r = rollbackLogs({ projectId: p.id, sinceTs: Date.now() + 60000 });
  assert.deepEqual(r.applied, []);
  assert.equal(r.blocked, false);
  Projects.remove(p.id);
  Projects.remove(other.id);
});

// ==================== 第 3 轮审计：写入契约 ====================
test('set_storyboard：clear 只清本次写入的章节，别的章节（含已出片镜头）必须保留', async () => {
  const p = mkProject('分镜clear范围项目');
  Chapters.create(p.id, { title: '第2章' });
  const ctx = createToolRuntime({ projectId: p.id });
  await runTool(ctx, 'set_storyboard', { shots: [{ chapter: '第1章', idx: 1, visual: '一章画面' }] });
  // 第2章放一条「已出片」的镜头：它就是被 clear 误删时损失最大的那种数据
  const s2 = Shots.create(p.id, { chapter: '第2章', idx: 1, visual: '二章画面' });
  Shots.update(s2.id, { status: 'done', video_path: 'shots/v.mp4', video_prompt: 'p', video_prompt_used: 'p' });
  // 模型的常见用法：clear=true 表示「本章从头写一遍」
  await runTool(ctx, 'set_storyboard', { clear: true, shots: [{ chapter: '第1章', idx: 1, visual: '一章重写' }] });
  const shots = Shots.list(p.id);
  assert.equal(shots.filter((s) => s.chapter === '第2章').length, 1, '别的章节的分镜不能被一起清掉');
  assert.equal(Shots.get(s2.id).video_path, 'shots/v.mp4', '别的章节已出片的镜头必须原样保留');
  const c1 = shots.filter((s) => s.chapter === '第1章');
  assert.equal(c1.length, 1, '本章按 idx 重写后仍是原条数');
  assert.equal(c1[0].visual, '一章重写');
  Projects.remove(p.id);
});

test('set_storyboard：同批「自动号在前、显式号在后」不再撞号吞内容', async () => {
  const p = mkProject('分镜镜号两遍分配项目');
  const ctx = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  await runTool(ctx, 'set_storyboard', { shots: [{ visual: '自动号' }, { idx: 1, visual: '显式1' }] });
  const shots = Shots.list(p.id);
  assert.equal(shots.length, 2, '两条都要落库（单遍分配时后一条会 upsert 覆盖前一条，内容静默丢失）');
  assert.deepEqual(shots.map((s) => s.idx).sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(shots.map((s) => s.visual).sort(), ['自动号', '显式1'].sort());
  Projects.remove(p.id);
});

test('narration：内置 Agent 与外部写入 API 同口径，可写旁白', async () => {
  const p = mkProject('分镜旁白项目');
  const ctx = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  // narration 是 shots 表的正文列（外部写入 API 的 SHOT_STRING_FIELDS 一直收它）：
  // 内置 Agent 漏了它时，模型按系统提示写旁白会整批 400。
  await runTool(ctx, 'set_storyboard', { shots: [{ idx: 1, visual: '画面', narration: '她想起那年冬天。' }] });
  const s = Shots.list(p.id)[0];
  assert.equal(s.narration, '她想起那年冬天。');
  await runTool(ctx, 'update_shot', { shot_id: s.id, narration: '改过的旁白。' });
  assert.equal(Shots.get(s.id).narration, '改过的旁白。');
  Projects.remove(p.id);
});

test('set_storyboard：对不上的资产名不再静默丢弃（随结果回报）', async () => {
  const p = mkProject('分镜资产名项目');
  Assets.create(p.id, { category: 'character', name: '小明' });
  const ctx = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  const r = await runTool(ctx, 'set_storyboard', { shots: [{ idx: 1, visual: '画面', characters: ['小明', '小铭'] }] });
  assert.match(r, /未找到同名资产/);
  assert.match(r, /人物「小铭」/);
  assert.equal(Shots.list(p.id)[0].character_ids.length, 1, '命中的名字照常绑定');
  Projects.remove(p.id);
});

test('换装兜底：LLM 阶段（renderDisabled）不渲染，推迟到「资产图」阶段执行', async () => {
  const p = mkProject('换装兜底阶段项目');
  const mkImg = (rel) => {
    const abs = path.join(projectDir(p.id), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
    return rel;
  };
  const ch = Assets.create(p.id, { category: 'character', name: '小明' });
  Assets.update(ch.id, { image_path: mkImg('assets/character/x.png') });
  // 预置一套「内容与提示词都没改过」的服装：兜底判定可复用 → 直接返回，不触发渲染
  const costume = Assets.create(p.id, { category: 'costume', name: '小明-沐浴后换上的干净衣裳', description: '沐浴后换上的干净衣裳', prompt: 'keep', parent_id: ch.id });
  Assets.update(costume.id, { status: 'done', image_path: mkImg('assets/costume/y.png'), prompt_used: 'keep' });

  // LLM 创作阶段：只检测、不生成（原先会绕过 runTool 的 RENDER_TOOLS 硬拦真的去渲染，
  // 而该阶段 ComfyUI 通常没启动 → 白等一次超时）
  const llmCtx = createToolRuntime({ projectId: p.id, chapter: '第1章', renderDisabled: true });
  const r = await runTool(llmCtx, 'set_storyboard', { shots: [
    { idx: 1, characters: ['小明'], visual: '小明在屋后沐浴' },
    { idx: 2, characters: ['小明'], visual: '小明擦着头发走出屋子' },
  ] });
  assert.match(r, /将在「资产图」阶段生成并绑定/, '推迟必须回报给模型，否则它会以为已经处理完');
  assert.ok(Shots.list(p.id).every((s) => s.costume_ids.length === 0), 'LLM 阶段不绑定（此刻没有服装可绑）');

  // 「资产图」阶段：同一份分镜文本，兜底在这里执行并绑定（同名服装直接复用，不真的渲染）
  const imgCtx = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  const prov = await resolveShotProvisions(imgCtx, ['第1章']);
  assert.equal(prov.outfit.generated, 1, '资产图阶段执行兜底');
  const after = Shots.list(p.id);
  assert.deepEqual(after.find((s) => s.idx === 2).costume_ids, [costume.id], '换装自「事件之后」的镜头起生效');
  assert.deepEqual(after.find((s) => s.idx === 1).costume_ids, [], '沐浴事件本身的镜头仍用角色原图');
  assert.match(prov.text, /自动换装/);
  Projects.remove(p.id);
});

test('素材库：同名音乐资产复用（重跑不堆重复条目）', () => {
  const p = mkProject('音乐资产复用项目');
  const ctx = createToolRuntime({ projectId: p.id });
  const a1 = upsertMusicAsset(ctx, '第1章背景音乐', { audio_path: 'assets/music/a.mp3', status: 'done' });
  const a2 = upsertMusicAsset(ctx, '第1章背景音乐', { audio_path: 'assets/music/b.mp3', status: 'done' });
  assert.equal(a1, a2, '同名复用同一条资产');
  const list = Assets.list(p.id, 'music');
  assert.equal(list.length, 1);
  assert.equal(list[0].audio_path, 'assets/music/b.mp3', '复用时原地更新音频');
  Projects.remove(p.id);
});

test('apply_chapter_music：单章合并失败不中断其余章节', async () => {
  const p = mkProject('应用BGM批量项目');
  Chapters.create(p.id, { title: '第2章' });
  // 两章都满足「全部已生成」的前置条件，但视频文件并不存在 → 第 1 章合并必然失败
  for (const t of ['第1章', '第2章']) {
    const s = Shots.create(p.id, { chapter: t, visual: '画面' });
    Shots.update(s.id, { status: 'done', video_path: 'shots/missing.mp4', video_prompt: 'p', video_prompt_used: 'p' });
  }
  const music = Assets.create(p.id, { category: 'music', name: 'BGM' });
  Assets.update(music.id, { audio_path: 'assets/music/x.mp3' });
  const ctx = createToolRuntime({ projectId: p.id });
  const r = JSON.parse(await runTool(ctx, 'apply_chapter_music', { music_id: music.id, chapters: ['第1章', '第2章'] }));
  assert.equal(r.results.length, 2, '两章都要有结果（原先第 1 章一抛错，第 2 章连碰都没碰）');
  assert.match(r.results[0].error || '', /合并成片失败/);
  Projects.remove(p.id);
});

test('章节标题：空标题会让整章分镜从章节视图消失，写入必须拒绝', () => {
  const p = mkProject('章节空标题项目');
  const cid = Chapters.list(p.id)[0].id;
  // 外部写入 API 的入口（PATCH …/chapters/:cid）
  assert.match(pickChapterFields({ title: '' }).errors.join('；'), /title 不能为空/);
  assert.match(pickChapterFields({ title: '   ' }).errors.join('；'), /title 不能为空/);
  assert.equal(pickChapterFields({ novel: '正文' }).errors.length, 0, '不带 title 时不校验');
  // db 层兜底：绕过路由直接调用也必须拒绝（空标题会绕过标题唯一性检查）
  assert.throws(() => Chapters.update(cid, { title: '' }), /标题不能为空/);
  assert.equal(Chapters.get(cid).title, '第1章');
  // 创建侧：显式空白标题在路由层被 pickChapterFields 拒掉；绕过路由（内部调用）时兜底成「第N章」，
  // 不能让「建得出来、却再也存不下去」的一章落库
  assert.match(pickChapterFields({ title: '\t ' }).errors.join('；'), /title 不能为空/);
  assert.equal(Chapters.create(p.id, { title: '   ' }).title, '第2章');
  assert.equal(Chapters.create(p.id, { novel: '只给正文' }).title, '第3章');
  assert.equal(Chapters.create(p.id, { title: '第9章' }).title, '第9章');
  Projects.remove(p.id);
});

test('PATCH 项目：只接受内容字段，status/context 等流水线字段必须拒绝', () => {
  const ok = pickProjectFields({ name: '甲', video_width: 1280.9, target_duration: 90.5, enable_bgm: false });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.patch.video_width, 1280, '像素取整');
  assert.equal(ok.patch.target_duration, 90.5, '时长是秒，允许小数');
  assert.equal(ok.patch.enable_bgm, false);
  // status 是流水线状态（前端「运行中」判定、/run、/stages 都读它）
  assert.match(pickProjectFields({ status: 'done' }).errors.join('；'), /不接受字段 status/);
  // context 只能在 PUT /context 写（同时落 context/*.md，从这个口进去会让 DB 与盘上文件脱节）
  assert.match(pickProjectFields({ context: {} }).errors.join('；'), /不接受字段 context/);
  assert.match(pickProjectFields({ video_width: 'abc' }).errors.join('；'), /不小于 0 的数字/);
});

test('素材分类：值域外的分类必须拒绝（否则界面与批量生成都扫不到这一行）', () => {
  const p = mkProject('素材分类项目');
  assert.throws(() => Assets.create(p.id, { category: '不存在的分类', name: 'x' }), /素材分类不存在/);
  assert.equal(Assets.list(p.id).length, 0);
  const a = Assets.create(p.id, { category: 'other', name: 'x' });
  assert.equal(a.category, 'other');
  // 改分类同样要守住：PATCH …/assets/:aid 的可编辑字段里有 category，
  // 只在 create 挡一次，等于留了「先把行建出来、再改成脏分类」的后门。
  assert.throws(() => Assets.update(a.id, { category: '不存在的分类' }), /素材分类不存在/);
  assert.equal(Assets.get(a.id).category, 'other');
  assert.equal(Assets.update(a.id, { category: 'scene' }).category, 'scene');
  Projects.remove(p.id);
});

test('参考素材上传：走渲染后端分派层（RunningHub 下必须传到云端并用平台 fileName）', async () => {
  const p = mkProject('参考素材后端分派项目');
  const abs = path.join(projectDir(p.id), 'assets/character/x.png');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x');
  const ch = Assets.create(p.id, { category: 'character', name: '小明' });
  Assets.update(ch.id, { image_path: 'assets/character/x.png' });
  const shot = Shots.create(p.id, { chapter: '第1章', idx: 1, character_ids: [ch.id] });

  const cfg = { comfyui: { provider: 'runninghub', apiKey: 'k', baseUrl: 'http://127.0.0.1:8188', tier: 'standard' } };
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url) => { calls.push(String(url)); return { ok: true, json: async () => ({ code: 0, data: { fileName: 'rh_uploaded_x.png' } }) }; };
  try {
    const r = await core.assembleShotReferences({ cfg, project: Projects.get(p.id), shot, assets: Assets.list(p.id), upload: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /runninghub\.cn/, '上传必须打给 RunningHub（云端工作流要的是平台 fileName）');
    assert.ok(!/127\.0\.0\.1:8188/.test(calls[0]), '不能打到本机 ComfyUI（原先写死 comfyui.baseUrl）');
    assert.deepEqual(r.references.filter((x) => x.type === 'image').map((x) => x.filename), ['rh_uploaded_x.png'], '工作流里要用平台返回的 fileName');
  } finally { global.fetch = orig; }
  Projects.remove(p.id);
});
