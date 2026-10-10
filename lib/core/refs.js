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
// upload=false：只解析参考清单与标签，不向 ComfyUI 上传文件（「仅 LLM 改写提示词、不渲染」用，
// 该路径无需 ComfyUI，也就不应因 ComfyUI 未启动而失败）。
export async function assembleShotReferences({ cfg, project, shot, assets, upload = true }) {
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
  // 年龄变体：把 age 资产按 parent_id 归属到角色；有时间跳跃时角色参考图改用对应时期变体
  const ageIds = (shot.age_ids || []).filter(Boolean);
  const ageByChar = {};
  for (const aid of ageIds) {
    const a = assets.find((x) => x.id === aid && x.category === 'age');
    if (a?.parent_id) ageByChar[a.parent_id] = a;
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
    if (upload) await uploadToInput(cfg.comfyui.baseUrl, abs, name);
    return name;
  };

  const references = [];
  for (const c of chars) {
    const costume = costumeByChar[c.id];
    const age = ageByChar[c.id];
    // 优先级：服装 > 年龄变体 > 角色原图（年龄与服装为两个独立维度，不做叠加）
    const imgAsset = (costume && costume.image_path) ? costume : ((age && age.image_path) ? age : c);
    const img = await uploadImageRef(imgAsset, 'char');
    if (img) references.push({ type: 'image', filename: img, label: c.name + (costume ? '（' + costume.name + '）' : (age ? '（' + age.name + '）' : '（人物形象）')) });
  }
  for (const s of scenes) {
    const img = await uploadImageRef(s, 'scene');
    if (img) references.push({ type: 'image', filename: img, label: s.name + '（场景背景）' });
  }
  for (const pr of props) {
    const img = await uploadImageRef(pr, 'prop');
    if (img) references.push({ type: 'image', filename: img, label: pr.name + '（道具）' });
  }
  // 音频参考统一走 MAX_AUDIO_REFS 上限（MiniMax H3 节点 maxAudioVideo 上限）。
  // 顺序：①说话角色的参考音色（多人同场仅说话角色才引用音色）→ ②分镜显式绑定的独立音频素材
  //（voice/music/sfx，含旁白音色），同样作为 H3 音色参考输入。
  const speakers = dialogueSpeakerNames(shot.dialogue);
  const speaks = (c) => speakers.some((s) => s === c.name || s.includes(c.name) || c.name.includes(s));
  const speakingChars = chars.filter(speaks);
  let audioTruncated = false;
  const pushAudio = async (rel, label, prefix) => {
    if (references.filter((r) => r.type === 'audio').length >= MAX_AUDIO_REFS) { audioTruncated = true; return; }
    if (!rel) return;
    const abs = resolveProjectPath(pid, rel);
    if (!abs || !fs.existsSync(abs)) {
      // 本地不存在该音频文件：不引用，避免 ComfyUI LoadAudio 报 Invalid audio file 而整图被拒
      logger.warn('跳过不存在的参考音频：' + rel);
      return;
    }
    const ext = path.extname(rel) || '.flac';
    const cName = 'ic_' + pid.slice(0, 8) + '_' + prefix + ext;
    if (upload) await uploadToInput(cfg.comfyui.baseUrl, abs, cName);
    references.push({ type: 'audio', filename: cName, label });
  };
  for (const c of speakingChars) {
    if (!c.voice_ref) continue;
    const voices = String(c.voice_ref).split(/[\n,;，；]+/).map((s) => s.trim()).filter(Boolean);
    for (let vi = 0; vi < voices.length; vi++) {
      await pushAudio(voices[vi], c.name + '的声音', 'voice_' + c.id.slice(0, 8) + '_' + vi);
    }
  }
  // 独立音频素材：优先 audio_path，其次 voice_ref（voice 资产两者都写、music/sfx 只有 audio_path）
  const audioLabel = { voice: '语音', music: '音乐', sfx: '音效' };
  for (const aid of (shot.audio_ids || []).filter(Boolean)) {
    const a = assets.find((x) => x.id === aid);
    if (!a) continue;
    await pushAudio(a.audio_path || a.voice_ref, a.name + '（' + (audioLabel[a.category] || '音频') + '）', 'audio_' + a.id.slice(0, 8));
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
