import path from 'node:path';
import fs from 'node:fs';
import { projectDir } from './config.js';
import { uploadTaskInput } from './backend.js';
import { extractFrame } from './ffmpeg.js';
import { logger } from './logger.js';
import { dialogueSpeakerNames, MAX_AUDIO_REFS } from './prompts.js';
import { nameMatches } from '../shared/index.js';

// 项目内相对路径 -> 绝对路径（asset.image_path / voice_ref 均相对项目目录存储）。
// 必须在这里做越界防护：rel 不全是可信的内部产物——asset.image_path / voice_ref 可由 HTTP PATCH、
// 以及 LLM 工具（update_asset.voice_ref、edit_asset_image.reference_image_path）写入，
// 而 novel 正文可经提示注入操纵这些工具参数。一旦 rel 是 '../..' 或绝对路径，
// path.resolve 会逃出项目目录，随后被 references 删除时 unlinkSync、被参考图提交时
// uploadTaskInput 上传到 ComfyUI/RunningHub、被 imageToDataUrl 读成 base64 —— 等于任意文件删/读。
// 越界一律返回 null，调用方按「文件不存在」处理（各调用点都已判 null）。
export function resolveProjectPath(projectId, rel) {
  if (!rel) return null;
  const base = projectDir(projectId);
  const abs = path.resolve(base, rel);
  const inside = path.relative(base, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return abs;
}

// 懒生成章节首帧预览图（存在即复用）：从章节第一个已完成分镜的视频抽首帧存为 jpg。
// 同一章节的抽取只允许一个在跑：GET /chapters 会被前端高频轮询（WS 每条进度都刷新 + 运行期每 2.5s 一次），
// 少了这道闸门，同一张 posters/<章节id>.jpg 会被多个请求并发抽取/写入，既同时起一堆 ffmpeg，
// 又可能写出半截文件——而「存在即复用」会让这张坏图被永久缓存下来。
const posterInflight = new Set();
export async function ensureChapterPoster(projectId, chapterId, firstDoneShot) {
  const rel = 'posters/' + chapterId + '.jpg';
  const abs = resolveProjectPath(projectId, rel);
  if (!abs) return '';
  if (fs.existsSync(abs)) return rel;
  if (posterInflight.has(abs)) return '';
  posterInflight.add(abs);
  try {
    const videoAbs = resolveProjectPath(projectId, firstDoneShot.video_path);
    if (!videoAbs || !fs.existsSync(videoAbs)) return '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await extractFrame(videoAbs, abs);
    return fs.existsSync(abs) ? rel : '';
  } catch { return ''; } finally { posterInflight.delete(abs); }
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
    // 走渲染后端分派层（backend.uploadTaskInput）：原生通道返回本地文件名；RunningHub 通道必须
    // 把文件传到平台并返回平台的 fileName，云端工作流里的 LoadImage 才找得到它。
    // 原先固定调 comfyui.uploadToInput（写死 127.0.0.1:8188）：RunningHub 模式下参考图传到本机，
    // 云端任务因缺输入失败、本机没开 ComfyUI 时直接 ECONNREFUSED——「参考图 → 视频」整条不可用。
    return upload ? await uploadTaskInput(cfg, abs, name) : name;
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
  // 规范化后精确相等（lib/shared 的 nameMatches）：用 includes 双向包含匹配时，
  // 同场的「明」会因为对白里「小明」说话而被误判为说话人 —— 它的音色被一起提交，
  // 音色错乱，还会挤掉 MAX_AUDIO_REFS 名额把后面真正的参考音频截断。
  const speaks = (c) => speakers.some((s) => nameMatches(s, c.name));
  const speakingChars = chars.filter(speaks);
  // 可观测性：对白里的说话人没匹配到本镜任何角色时，其音色会被静默跳过（不报错，用户只看到「这一镜没有声音」）。
  // 典型来源是「李雷，韩梅梅：台词」这类一行多说话人标签——dialogueSpeakerNames 会把整串逗号名当成一个名字，
  // 而 nameMatches 是规范化后精确相等，于是两人谁都匹配不上（顺带也让「单镜 ≤2 说话人」的校验失效）。
  // 这里只提示、不改判定：拆逗号会误伤台词正文（「小明，别走」），说话人归属属于内容层问题。
  const unmatchedSpeakers = speakers.filter((s) => !chars.some((c) => nameMatches(s, c.name)));
  if (unmatchedSpeakers.length) {
    logger.warn('分镜对白里的说话人未匹配到本镜角色，其音色不会被引用：' + unmatchedSpeakers.join('、')
      + '（每行台词只写一个说话人，如「李雷：你好」；多个说话人请拆成多行/多镜）');
  }
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
    // 同 uploadImageRef：音频也必须走分派层（RunningHub 下需平台 fileName）
    const useName = upload ? await uploadTaskInput(cfg, abs, cName) : cName;
    references.push({ type: 'audio', filename: useName, label });
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
  return { references, chars, scenes, characterName, characterDesc, sceneDesc, unmatchedSpeakers };
}
