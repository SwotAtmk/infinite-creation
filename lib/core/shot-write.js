// 分镜「内容字段」白名单、归一化与业务校验：外部写入 API（harness）与内置 Agent 共用。
//
// 只开放内容字段；status / error / video_path / video_prompt_used / prompt_id 属于生成流水线产物，
// 由渲染阶段写，外部写入必须拒绝——否则客户端可以伪造「已生成」状态，绕过渲染直接出成片。
//
// 除了「字段名 / 类型」，这里还兜住「业务约束」：时长区间、台词速度、说话人数量、分辨率枚举。
// 这些约束原先只在内置 Agent 的 set_storyboard / update_shot 里做，外部 API 直写会整条绕过；
// 结果是「写入完全合法、却在几分钟后的渲染阶段才炸」（或出一段听不清的语音）——错误离写入点太远。
import { dialogueSpeakerNames, MAX_SPEAKERS_PER_SHOT } from './prompts.js';
import { VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS } from '../shared/index.js';

export const SHOT_STRING_FIELDS = ['chapter', 'scene_name', 'camera', 'visual', 'dialogue', 'narration', 'sub_shots', 'resolution', 'aspect_ratio', 'video_prompt'];
export const SHOT_ARRAY_FIELDS = ['character_ids', 'scene_ids', 'prop_ids', 'costume_ids', 'age_ids', 'audio_ids', 'references'];
export const SHOT_NUMBER_FIELDS = ['idx', 'duration'];
// seed **不在**可写字段里：它是渲染参数/产物，不是内容。generateShotVideo 每次渲染都现取一个
// 随机种子写回（tools.js），而整条渲染链路从不读 shots.seed 当输入——外部写进来的 seed 下一次
// 渲染就被覆盖，同时它又在 changelog 的 VOLATILE.shot 里（不进变更日志、回滚也恢复不了）。
// 收下它等于「接口答应得下、实际静默无效」，与 status/video_path 同口径拒收。
// 要支持「钉住种子复现」，得先让渲染读它（非 0 沿用）并把它从 VOLATILE 拆出来——那是功能变更，
// 不在审计范围内。

// 取值域与「谁在消费它」对齐。表在 lib/shared/index.js（单一事实来源，与工作流映射表、
// 界面下拉共用一份；tests 里有一条一致性回归盯着三者不许漂移）：
// - resolution：未命中的值会被 workflow-runner 的 mapRoleValue 原样写进 ComfyUI 参数，
//   直到提交才报错，所以必须在写入口挡住。
// - aspect_ratio：工作流映射表 aspect_ratio.map 的键。
// 空字符串是合法值：表示「继承项目设置」（生成时用 shot.resolution || project.video_resolution）。
export const SHOT_RESOLUTIONS = VIDEO_RESOLUTIONS;
export const SHOT_ASPECT_RATIOS = VIDEO_ASPECT_RATIOS;
// 时长上下限：H3 单镜上限 15 秒；台词速度沿用 tools.js hSetStoryboard 的 MAX_RATE = 5.5 字/秒。
export const SHOT_DURATION_MIN = 1;
export const SHOT_DURATION_MAX = 15;
export const SHOT_DIALOGUE_MAX_RATE = 5.5;
// 与 db.js Shots.create / Shots.update 的默认值一致：校验必须按「真正落库的值」算，
// 否则「省略 duration + 长台词」会算错上限、放过去一批必然超速的分镜。
export const SHOT_DURATION_DEFAULT = 5;

const ALL = new Set([...SHOT_STRING_FIELDS, ...SHOT_ARRAY_FIELDS, ...SHOT_NUMBER_FIELDS]);

// 白名单外的一律报错（不静默丢弃）：拼错字段名要立刻可见，与 Agent 工具的参数封闭校验同一思路。
export function pickShotFields(body) {
  const patch = {};
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { patch, errors: ['请求体必须是 JSON 对象'] };

  for (const k of Object.keys(body)) {
    if (!ALL.has(k)) errors.push('不接受字段 ' + k);
  }

  for (const k of SHOT_STRING_FIELDS) {
    if (body[k] === undefined) continue;
    const v = String(body[k] ?? '');
    if (k === 'resolution' && v && !SHOT_RESOLUTIONS.includes(v)) {
      errors.push('resolution 只能是 ' + SHOT_RESOLUTIONS.join('/') + '（当前：' + v + '）');
      continue;
    }
    if (k === 'aspect_ratio' && v && !SHOT_ASPECT_RATIOS.includes(v)) {
      errors.push('aspect_ratio 只能是 ' + SHOT_ASPECT_RATIOS.join('/') + '（当前：' + v + '）');
      continue;
    }
    patch[k] = v;
  }
  for (const k of SHOT_ARRAY_FIELDS) {
    if (body[k] === undefined) continue;
    if (!Array.isArray(body[k])) { errors.push(k + ' 必须是字符串数组'); continue; }
    patch[k] = body[k].map((v) => String(v ?? '')).filter(Boolean);
  }
  for (const k of SHOT_NUMBER_FIELDS) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n)) { errors.push(k + ' 必须是有限数字'); continue; }
    if (k === 'idx') {
      // idx 是「章内镜号」：≥1 才和 Agent 侧（章内 max+1）以及 Shots.list 的排序口径一致
      const i = Math.trunc(n);
      if (i < 1) { errors.push('idx 必须是不小于 1 的整数'); continue; }
      patch[k] = i;
      continue;
    }
    // duration 必须**显式判名**：这里原本是「兜底分支」，任何白名单里的数字字段走到最后都会
    // 被按 duration 的区间校验，报出牛头不对马嘴的错（例如 seed=123456 → 「duration 必须在
    // 1~15 秒之间」）。日后往 SHOT_NUMBER_FIELDS 加字段，请在这里补显式分支。
    if (k === 'duration') {
      if (n < SHOT_DURATION_MIN || n > SHOT_DURATION_MAX) {
        errors.push('duration 必须在 ' + SHOT_DURATION_MIN + '~' + SHOT_DURATION_MAX + ' 秒之间（当前：' + n + '）');
        continue;
      }
      patch[k] = n;
    }
  }

  return { patch, errors };
}

// 跨字段业务校验。patch 是本次要写入的字段，current 是行已有值（新建时传 {}）——
// 「只改台词不改时长」需要拿已有时长算上限，所以必须两者一起看。
export function validateShotContent(patch, current = {}) {
  const errors = [];
  // chapter 是分镜的归属键（shots.chapter 存章节标题，章节视图/待办统计/成片都按它归属）。
  // 显式传空串不会报错，只会把这条分镜从章节视图与 chapterStats 里抹掉——UI 看不见它，
  // 却仍会被整片导出。省略该字段 = 不改归属；要换章必须给真实存在的标题。
  if (patch.chapter !== undefined && !String(patch.chapter).trim()) {
    errors.push('chapter 不能为空——分镜必须归属某个章节；不改归属请省略该字段');
  }
  const dur = patch.duration !== undefined ? patch.duration : (Number(current.duration) > 0 ? Number(current.duration) : SHOT_DURATION_DEFAULT);
  const dialogue = patch.dialogue !== undefined ? patch.dialogue : (current.dialogue || '');

  // 与 tools.js hSetStoryboard 同一公式（含标点计数）：超速会被 TTS/H3 压成听不清的模糊声
  const chars = String(dialogue).length;
  if (chars && dur > 0 && chars / dur > SHOT_DIALOGUE_MAX_RATE) {
    errors.push('dialogue 超速：' + chars + ' 字 / ' + dur + ' 秒（上限 ' + Math.floor(dur * SHOT_DIALOGUE_MAX_RATE)
      + ' 字，约 ' + SHOT_DIALOGUE_MAX_RATE + ' 字/秒）——请缩短台词、延长时长（最长 ' + SHOT_DURATION_MAX + ' 秒）或拆成多个分镜');
  }

  // 说话人数量决定参考音色段数，超限会被 reject（单镜最多 MAX_SPEAKERS_PER_SHOT 人）
  const speakers = dialogueSpeakerNames(dialogue);
  if (speakers.length > MAX_SPEAKERS_PER_SHOT) {
    errors.push('dialogue 说话人 ' + speakers.length + ' 个 > 上限 ' + MAX_SPEAKERS_PER_SHOT + '（' + speakers.join('、') + '）——请拆成多个分镜');
  }

  return errors;
}

// —— 章内镜号唯一 ——
// idx 是「章内镜号」，同一章内必须唯一：assemble_video / 成片都按「章节 seq → 章内 idx」排序，
// 撞号会让排序结果不确定（同样的数据两次导出顺序可能不同）。
// 一次请求内部的重复由各自处理（storyboard 路由有 usedIdx、Agent 的 set_storyboard 按 idx
// upsert 并把本批新行登记回 byKey），这里负责「与库里已有行冲突」——跨批写入的唯一缺口：
// POST /shots 显式给 idx、PATCH /shots/:sid 改 idx、storyboard replace:false 追加时都给一下。
export function idxTakenBy(shots, chapter, idx, excludeId = '') {
  const n = Number(idx);
  if (!Number.isFinite(n)) return null;
  return shots.find((s) => s.chapter === chapter && Number(s.idx) === n && s.id !== excludeId) || null;
}

// —— 章节内容字段白名单 ——
// 章节 PATCH 原先把请求体整个丢给 Chapters.update，而它会写 title/novel/script/**seq/status/
// music_path/music_prompt/music_prompt_used**——后四个是流水线产物与叙事顺序键：
// 外部写入改 seq 会与别的章节撞号（reorder 专门拦了这种情况，这里却绕过去了），成片顺序
// 从此不确定；改 status 能伪造「已生成」。拼错的字段（titel）也会被静默忽略、却回 200
// 说改成功了。所以与分镜同口径：只认内容字段，其余当场拒绝。
export const CHAPTER_STRING_FIELDS = ['title', 'novel', 'script'];

export function pickChapterFields(body) {
  const patch = {};
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { patch, errors: ['请求体必须是 JSON 对象'] };
  for (const k of Object.keys(body)) {
    if (!CHAPTER_STRING_FIELDS.includes(k)) errors.push('不接受字段 ' + k);
  }
  for (const k of CHAPTER_STRING_FIELDS) {
    if (body[k] === undefined) continue;
    const v = String(body[k] ?? '');
    // 标题是业务键（分镜按 title 归属），必须非空：写成空串会让本章分镜从章节视图与
    // chapterStats 里彻底消失（成片却仍把它们算进去），而空标题又会绕过 assertChapterTitleFree
    // 的唯一性检查，同时存在多个空标题章节。与分镜侧 validateShotContent 拒绝空 chapter 对称。
    if (k === 'title' && !v.trim()) { errors.push('title 不能为空——分镜按章节标题归属；不改标题请省略该字段'); continue; }
    patch[k] = v;
  }
  return { patch, errors };
}

// —— 项目内容字段白名单 ——
// PATCH /api/projects/:id 原先把请求体整个丢给 Projects.update，而它会写 status 与 context：
// - status 是流水线状态（前端「运行中」判定、/run、/stages 都读它），外部写能伪造「运行中/已完成」；
// - context 是人物圣经/风格/连续性的唯一载体，而 context/*.md 只在 PUT /context 里同写——
//   从这个口进去只会让「界面里一套、盘上一套」（见 context/route.js 的说明）。
// 与分镜/章节同口径：只认内容字段，其余当场拒绝（不静默忽略）。
export const PROJECT_STRING_FIELDS = ['name', 'novel', 'idea', 'style'];
export const PROJECT_ENUM_FIELDS = ['video_resolution', 'video_aspect_ratio'];
export const PROJECT_NUMBER_FIELDS = ['video_width', 'video_height', 'target_duration'];
export const PROJECT_BOOL_FIELDS = ['enable_bgm'];
const PROJECT_ALL = new Set([...PROJECT_STRING_FIELDS, ...PROJECT_ENUM_FIELDS, ...PROJECT_NUMBER_FIELDS, ...PROJECT_BOOL_FIELDS]);

export function pickProjectFields(body) {
  const patch = {};
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { patch, errors: ['请求体必须是 JSON 对象'] };
  for (const k of Object.keys(body)) {
    if (!PROJECT_ALL.has(k)) errors.push('不接受字段 ' + k);
  }
  for (const k of PROJECT_STRING_FIELDS) if (body[k] !== undefined) patch[k] = String(body[k] ?? '');
  for (const k of PROJECT_ENUM_FIELDS) if (body[k] !== undefined) patch[k] = String(body[k] ?? '');
  for (const k of PROJECT_NUMBER_FIELDS) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0) { errors.push(k + ' 必须是不小于 0 的数字（当前：' + body[k] + '）'); continue; }
    // 宽高是 INTEGER 列（像素），时长是 REAL 列（秒，允许小数）。
    // 宽高的上下限不在这里判：那是「生成端约束」，db 层统一校验（见 db.js projectDims），
    // UI / 内置 Agent / 外部 harness 三条写入路径共用一份，避免校验各写一份而漂移。
    patch[k] = k === 'target_duration' ? n : Math.trunc(n);
  }
  for (const k of PROJECT_BOOL_FIELDS) {
    if (body[k] === undefined) continue;
    const v = body[k];
    patch[k] = !(v === false || v === 0 || v === '0' || v === 'false');
  }
  return { patch, errors };
}
