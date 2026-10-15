// 分镜「内容字段」白名单与归一化：外部写入 API（harness）与内置 Agent 共用。
//
// 只开放内容字段；status / error / video_path / video_prompt_used / prompt_id 属于生成流水线产物，
// 由渲染阶段写，外部写入必须拒绝——否则客户端可以伪造「已生成」状态，绕过渲染直接出成片。
export const SHOT_STRING_FIELDS = ['chapter', 'scene_name', 'camera', 'visual', 'dialogue', 'narration', 'sub_shots', 'resolution', 'aspect_ratio', 'video_prompt', 'parent_shot_id'];
export const SHOT_ARRAY_FIELDS = ['character_ids', 'scene_ids', 'prop_ids', 'costume_ids', 'age_ids', 'audio_ids', 'references'];
export const SHOT_NUMBER_FIELDS = ['idx', 'duration', 'seed'];

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
    if (body[k] !== undefined) patch[k] = String(body[k] ?? '');
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
    if (k === 'idx' || k === 'seed') { patch[k] = Math.trunc(n); continue; }
    if (n < 0) { errors.push(k + ' 不能为负'); continue; }
    patch[k] = n;
  }

  return { patch, errors };
}
