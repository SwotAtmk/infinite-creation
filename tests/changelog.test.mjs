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
const { createToolRuntime, runTool } = await import('../lib/agent/tools.js');
const {
  Projects, Chapters, Shots, listChanges, countChanges, rollbackLogs,
  withWriteContext, rawGet, pickShotFields, validateShotContent, tx, DB_PATH, chapterStats,
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
