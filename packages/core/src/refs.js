import path from 'node:path';
import fs from 'node:fs';
import { projectDir } from './config.js';
import { uploadToInput } from './comfyui.js';
import { logger } from './logger.js';
import { dialogueSpeakerNames, MAX_AUDIO_REFS } from './prompts.js';

// 项目内相对路径 -> 绝对路径（asset.image_path / voice_ref 均相对项目目录存储）
export function resolveProjectPath(projectId, rel) {
  if (!rel) return null;
  return path.resolve(projectDir(projectId), rel);
}

// 组装一个分镜的参考素材（MiniMax H3 全能参考范式：多图 + 多音视频）。
// 顺序：人物图 -> 场景图 -> 道具图 -> 人物语音。
export async function assembleShotReferences({ cfg, project, shot, assets }) {
  const pid = project.id;
  const charIds = (shot.character_ids && shot.character_ids.length) ? shot.character_ids : [];
  const sceneIds = (shot.scene_ids && shot.scene_ids.length) ? shot.scene_ids : [];
  const chars = charIds.map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  const scenes = sceneIds.map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  const props = (shot.prop_ids || []).map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  const costumeIds = (shot.costume_ids || []).filter(Boolean);
  // 服装替换：把 costume 资产按 parent_id 归属到角色；有服装时角色参考图改用服装图
  const costumeByChar = {};
  for (const cid of costumeIds) {
    const c = assets.find((a) => a.id === cid && a.category === 'costume');
    if (c?.parent_id) costumeByChar[c.parent_id] = c;
  }
  // 至少需要一张参考图（人物或场景）；无图的人物会被自然跳过
  const hasImage = [...chars, ...scenes, ...props].some((a) => a?.image_path);
  if (!hasImage) throw new Error('请先为该分镜生成至少一张参考图（人物或场景）');

  const uploadImageRef = async (asset, role) => {
    if (!asset?.image_path) return null;
    const abs = resolveProjectPath(pid, asset.image_path);
    if (!abs || !fs.existsSync(abs)) return null;
    const ext = path.extname(abs) || '.png';
    const name = 'ic_' + pid.slice(0, 8) + '_' + role + '_' + asset.id.slice(0, 8) + ext;
    await uploadToInput(cfg.comfyui.baseUrl, abs, name);
    return name;
  };

  const references = [];
  for (const c of chars) {
    const costume = costumeByChar[c.id];
    const imgAsset = (costume && costume.image_path) ? costume : c;
    const img = await uploadImageRef(imgAsset, 'char');
    if (img) references.push({ type: 'image', filename: img, label: c.name + (costume ? '（' + costume.name + '）' : '（人物形象）') });
  }
  for (const s of scenes) {
    const img = await uploadImageRef(s, 'scene');
    if (img) references.push({ type: 'image', filename: img, label: s.name + '（场景背景）' });
  }
  for (const pr of props) {
    const img = await uploadImageRef(pr, 'prop');
    if (img) references.push({ type: 'image', filename: img, label: pr.name + '（道具）' });
  }
  // 语音参考：只提交「有台词」角色的 voice_ref——多人同场时不要把全部在场角色的音色都塞进参考素材，
  // 仅说话角色才引用其音色；再按 MAX_AUDIO_REFS 上限截断，保证单分镜音频段数永不超限。
  const speakers = dialogueSpeakerNames(shot.dialogue);
  const speaks = (c) => speakers.some((s) => s === c.name || s.includes(c.name) || c.name.includes(s));
  const speakingChars = chars.filter(speaks);
  let audioTruncated = false;
  for (const c of speakingChars) {
    if (!c.voice_ref) continue;
    const voices = String(c.voice_ref).split(/[\n,;，；]+/).map((s) => s.trim()).filter(Boolean);
    for (let vi = 0; vi < voices.length; vi++) {
      if (references.filter((r) => r.type === 'audio').length >= MAX_AUDIO_REFS) { audioTruncated = true; break; }
      const v = voices[vi];
      const abs = resolveProjectPath(pid, v);
      if (abs && fs.existsSync(abs)) {
        const ext = path.extname(v) || '.flac';
        const cName = 'ic_' + pid.slice(0, 8) + '_voice_' + c.id.slice(0, 8) + '_' + vi + ext;
        await uploadToInput(cfg.comfyui.baseUrl, abs, cName);
        references.push({ type: 'audio', filename: cName, label: c.name + '的声音' });
      } else {
        // 本地不存在该音色文件：不引用，避免 ComfyUI LoadAudio 报 Invalid audio file 而整图被拒
        logger.warn('跳过不存在的参考音色：' + v + '（请把音色文件放到 assets/voice/ 并登记 voice_ref）');
      }
    }
  }
  if (audioTruncated) logger.warn('参考音频超过 ' + MAX_AUDIO_REFS + ' 段，已截断（仅保留前 ' + MAX_AUDIO_REFS + ' 段）');
  if (!references.length) throw new Error('没有可用的参考素材（人物图/场景图/道具图/语音）');

  const imgCount = references.filter((r) => r.type === 'image').length;
  const avCount = references.filter((r) => r.type === 'audio' || r.type === 'video').length;
  if (imgCount > 9) throw new Error('参考图片过多（最多 9 张），当前 ' + imgCount + ' 张');
  if (avCount > MAX_AUDIO_REFS) throw new Error('参考音视频过多（最多 ' + MAX_AUDIO_REFS + ' 段），当前 ' + avCount + ' 段');

  const characterName = chars[0]?.name || '';
  const characterDesc = chars.map((c) => c.description || c.name).filter(Boolean).join('；');
  const sceneDesc = scenes.map((s) => s.description || s.name).filter(Boolean).join('；');
  return { references, chars, scenes, characterName, characterDesc, sceneDesc };
}
