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
export const SHOT_NUMBER_FIELDS = ['idx', 'duration', 'seed'];

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
    if (k === 'seed') { patch[k] = Math.trunc(n); continue; }
    if (n < SHOT_DURATION_MIN || n > SHOT_DURATION_MAX) {
      errors.push('duration 必须在 ' + SHOT_DURATION_MIN + '~' + SHOT_DURATION_MAX + ' 秒之间（当前：' + n + '）');
      continue;
    }
    patch[k] = n;
  }

  return { patch, errors };
}

// 跨字段业务校验。patch 是本次要写入的字段，current 是行已有值（新建时传 {}）——
// 「只改台词不改时长」需要拿已有时长算上限，所以必须两者一起看。
export function validateShotContent(patch, current = {}) {
  const errors = [];
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
