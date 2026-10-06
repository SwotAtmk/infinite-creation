import path from 'node:path';
import fs from 'node:fs';
import {
  loadConfig, Projects, Assets, Shots, Chapters, Workflows,
  logger, uid, slugify, randomSeed,
  ensureProjectDirs, projectDir, resolveProjectPath,
  assembleShotReferences, fallbackVideoPrompt, validateSubShots,
  dialogueSpeakerNames, MAX_SPEAKERS_PER_SHOT,
  fallbackAssetPrompt, llmChat, extractJson,
  imageToDataUrl, buildVisionUserMessage,
  runWorkflow, pickOutput, downloadToFile, getSpecForKind, uploadToInput,
  mergeVideos,
} from '../core/index.js';
import { PROJECT_ASSET_SUBDIRS, ASSET_CATEGORY_IDS, ratioToSize } from '../shared/index.js';
import { loadSkillWithResources, renderSkillContent } from './skill-engine.js';

// ================= 工具定义（OpenAI function-calling） =================
export const TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'skill', description: '加载一个可用技能的完整说明与参考文件索引，返回技能正文后严格遵循；需要某个参考文件全文时再用 skill_reference。命中以下任务前必须先调用：写视频提示词→skill(h3-prompt-writing)；拆分镜脚本→skill(story-pipeline-cn)；写图片/图生图提示词→skill(image-prompt-writing)；设计人物音色→skill(tts-voice-design)；总流水线→skill(novel-to-video)。短剧/漫剧：短剧编剧→skill(0715-scriptwriter)；剧本总控→skill(script-master)；小说改编→skill(novel-to-skitscreenplay)；转分镜→skill(novel-to-storyboard)；文字分镜JSON→skill(hf-drama-storyboard-script)；漫剧策划→skill(ai-manga-planner)；漫剧导演→skill(manju-director-agent)；漫剧全流程→skill(manga-drama-generator)；脚本转漫剧→skill(script-to-manga)；分镜解析→skill(comic-drama-generator)；镜头库/影视级→skill(cinematic-ai-comic-director)；道具年代一致→skill(era-consistency-optimizer)；全栈分镜提示词→skill(manga-full-stack)。', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'skill_reference', description: '加载某技能 references 目录下的单个参考文件全文（例如 skill_reference(name="script-master", ref="framework.md")）。先用 skill() 查看该技能的参考文件索引，再按需加载单个文件。', parameters: { type: 'object', properties: { name: { type: 'string' }, ref: { type: 'string' } }, required: ['name', 'ref'] } } },
  { type: 'function', function: { name: 'get_project', description: '读取当前项目信息与上下文摘要（人物圣经/风格指南/连续性记录），含章节列表。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'list_chapters', description: '列出项目章节（每章的标题/序号/状态/该章分镜数）。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'save_context', description: '写入项目上下文文件：bible（人物圣经）/ style（风格指南）/ continuity（连续性记录，追加）。', parameters: { type: 'object', properties: { key: { type: 'string', enum: ['bible', 'style', 'continuity'] }, content: { type: 'string' } }, required: ['key', 'content'] } } },
  { type: 'function', function: { name: 'report', description: '向任务进度汇报一条状态（阶段/详情）。', parameters: { type: 'object', properties: { phase: { type: 'string' }, detail: { type: 'string' } }, required: ['detail'] } } },
  { type: 'function', function: { name: 'list_assets', description: '列出项目资产，可按分类过滤。', parameters: { type: 'object', properties: { category: { type: 'string', enum: ASSET_CATEGORY_IDS } } } } },
  { type: 'function', function: { name: 'create_asset', description: '创建资产（人物/场景/道具/语音/其他）。', parameters: { type: 'object', properties: { category: { type: 'string', enum: ASSET_CATEGORY_IDS }, name: { type: 'string' }, description: { type: 'string' } }, required: ['category', 'name'] } } },
  { type: 'function', function: { name: 'update_asset', description: '更新资产字段（描述/提示词/参考语音/一致性锚点）。', parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, prompt: { type: 'string' }, negative_prompt: { type: 'string' }, voice_ref: { type: 'string' }, consistency_key: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'generate_asset_image', description: '文生图生成资产图片（Qwen-Image-2512）。prompt 为空时用资产描述兜底。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, prompt: { type: 'string' }, negative_prompt: { type: 'string' }, ratio: { type: 'string' } }, required: ['asset_id'] } } },
  { type: 'function', function: { name: 'edit_asset_image', description: '图生图/图像编辑（Qwen-Image-Edit-2511）：以参考图 + 指令生成新图，用于一致性变体。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, prompt: { type: 'string' }, reference_asset_id: { type: 'string' } }, required: ['asset_id', 'prompt'] } } },
  { type: 'function', function: { name: 'change_outfit', description: '人物换装：以角色 canonical 参考图为参考，用图生图（Qwen-Image-Edit）生成该角色的一套新服装资产（category=costume，parent_id 指向角色），供分镜按章引用。label 为服装短名（如「进城旧衣」），用于资产命名与分镜引用；outfit 为服装外观描述。剧情出现沐浴/洗澡/更衣/换衣/换装/换上(新)衣等换装事件后，必须调用本工具为该角色生成新服装，并在换装事件之后的镜头用 set_storyboard 的 costumes 字段引用。', parameters: { type: 'object', properties: { character_id: { type: 'string' }, outfit: { type: 'string' }, label: { type: 'string' }, prompt: { type: 'string' } }, required: ['character_id', 'outfit'] } } },
  { type: 'function', function: { name: 'design_outfits', description: '给角色一次性设计并生成多套服装资产（衣橱）：以角色 canonical 参考图为参考，用图生图为每套服装生成一张服装图（category=costume，parent_id 指向角色），供分镜按服装名引用对应那套。outfits 传该角色的多套服装清单，每套含 name（服装短名，如「进城旧衣」「沐浴后家居服」「金缕阁新衣」）与 description（服装外观描述）。', parameters: { type: 'object', properties: { character_id: { type: 'string' }, outfits: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] } } }, required: ['character_id', 'outfits'] } } },
  { type: 'function', function: { name: 'view_asset', description: '查看某资产的参考图（视觉模型）：返回资产元数据与图片块；模型不支持图片输入时仅返回文本。', parameters: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] } } },
  { type: 'function', function: { name: 'view_shot_references', description: '查看某分镜的参考素材图（角色/场景/道具/服装，视觉模型）：返回清单与 ≤9 张参考图；模型不支持图片输入时仅返回文本。', parameters: { type: 'object', properties: { shot_id: { type: 'string' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'register_voice', description: '登记资产（人物）的参考音色文件名（相对项目 assets/voice/）。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, voice_ref: { type: 'string' } }, required: ['asset_id', 'voice_ref'] } } },
  { type: 'function', function: { name: 'design_voice', description: '用 Qwen3 TTS 音色设计工作流为人物设计音色：text 是人物朗读的简短自我介绍文案（20~30 字，约 5 秒，禁止长篇大论），voice_description 是音色描述（不限制字数，可详细写）。生成语音样本并存为该项目 voice_ref。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, text: { type: 'string', description: '人物朗读的简短自我介绍，20~30 字，约 5 秒' }, voice_description: { type: 'string', description: '音色描述，不限制字数' } }, required: ['asset_id'] } } },
  { type: 'function', function: { name: 'generate_assets_batch', description: '按工作流类型分批统一生成项目素材：先连续文生图全部图片类资产（人物/场景/道具），再连续设计全部人物音色（Qwen3-TTS），避免反复切换工作流导致 ComfyUI 重复加载模型、为项目提速。已生成成功的资产自动跳过（幂等）。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'set_storyboard', description: '写入/追加分镜列表（按 idx upsert，非破坏：已生成的分镜保留 status/video，新增章节按更高 idx 追加）。characters/scenes/props/costumes 传资产名数组（costumes 为换装后的服装资产名，沐浴/更衣/换装事件之后的镜头必须引用对应服装，事件之前的镜头不引用）；chapter 传章节号。硬约束：dialogue 字数必须 ≤ duration×5（中文旁白约 4-5 字/秒），超长会被拒绝，需缩短台词或拆镜；每个分镜最多 2 个说话人，≥3 人对话会被拒绝，需拆成多个分镜（参考音频只提交有台词角色，单分镜 ≤3 段）。', parameters: { type: 'object', properties: { shots: { type: 'array', items: { type: 'object', properties: { idx: { type: 'number' }, chapter: { type: 'string' }, scene_name: { type: 'string' }, duration: { type: 'number' }, characters: { type: 'array', items: { type: 'string' } }, scenes: { type: 'array', items: { type: 'string' } }, props: { type: 'array', items: { type: 'string' } }, costumes: { type: 'array', items: { type: 'string' } }, sub_shots: { type: 'string' }, dialogue: { type: 'string' }, camera: { type: 'string' }, visual: { type: 'string' } } } }, clear: { type: 'boolean' } }, required: ['shots'] } } },
  { type: 'function', function: { name: 'list_shots', description: '列出项目分镜及其状态。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'update_shot', description: '更新某分镜字段（video_prompt 为按 h3-prompt-writing 技能写好的 H3 视频提示词，生成视频前必须先写入）。', parameters: { type: 'object', properties: { shot_id: { type: 'string' }, sub_shots: { type: 'string' }, dialogue: { type: 'string' }, camera: { type: 'string' }, visual: { type: 'string' }, duration: { type: 'number' }, video_prompt: { type: 'string' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'generate_shot_video', description: '为某分镜生成视频（MiniMax H3 Ref2VA）。', parameters: { type: 'object', properties: { shot_id: { type: 'string' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'regenerate_shot', description: '重新生成某分镜视频，可带反馈文字（如「镜头拉近/让人物微笑」）。', parameters: { type: 'object', properties: { shot_id: { type: 'string' }, feedback: { type: 'string' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'generate_chapter_videos', description: '为指定章节一次性生成/补齐全部镜头视频（确定性批量循环，不省略任何镜头）；force=true 时强制重生成本章全部视频（含已 done）。失败的镜头标记为 failed 并继续，直到该章所有镜头 done 或逐个失败。不受步数/时长限制，会一直跑到该章全部镜头有结果。', parameters: { type: 'object', properties: { chapter: { type: 'string' }, force: { type: 'boolean' } }, required: ['chapter'] } } },
  { type: 'function', function: { name: 'assemble_video', description: '用 ffmpeg 合并全部分镜视频为成片。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_workflows', description: '列出已注册的 ComfyUI 工作流。', parameters: { type: 'object', properties: {} } } },
];

// ================= 运行时上下文 =================
export function createToolRuntime({ projectId, jobId, onProgress, isAborted, chapter }) {
  const cfg = loadConfig();
  const project = Projects.get(projectId);
  if (!project) throw new Error('项目不存在：' + projectId);
  ensureProjectDirs(projectId);
  return {
    cfg, project, projectId, jobId,
    chapter: chapter || '',
    onProgress: onProgress || (() => {}),
    isAborted: isAborted || (() => false),
    report(patch) {
      if (this.onProgress) this.onProgress(patch);
      logger.info('agent: ' + (patch.phase || '') + ' ' + (patch.detail || ''), patch);
    },
  };
}

// ================= 内部辅助 =================
function saveToProject(ctx, relPath, buf) {
  const abs = resolveProjectPath(ctx.projectId, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return relPath;
}

async function downloadOutputTo(ctx, out, relPath) {
  return downloadToFile(ctx.cfg, out, resolveProjectPath(ctx.projectId, relPath));
}

function assetFallback(asset, project) {
  return fallbackAssetPrompt({ type: asset.category, name: asset.name, description: asset.description, style: project.style });
}

function visionEnabled(ctx) { return !!(ctx.cfg?.llm?.vision); }

// 把本地图片绝对路径列表转成 { data, mimeType } 图片块（视觉模型投喂），跳过不可读/超大文件
// 视觉投喂的参考图做限流：默认最多 6 张、单张 ≤2.5MB，避免大量超大图把对话上下文撑爆，
// 进而触发 openclaude 的 active-message 安全上限（自动压缩压不动时直接停跑）。
function imagesFromPaths(absPaths, max = 6) {
  const out = [];
  for (const p of (absPaths || [])) {
    if (out.length >= max) break;
    if (!p) continue;
    const img = imageToDataUrl(p, { maxBytes: 2.5 * 1024 * 1024 });
    if (img) out.push(img);
  }
  return out;
}

// 超时预算按本机实测吞吐给：视频单条 15-30 分钟，且 ComfyUI 队列串行，
// 超时必须覆盖排队等待，否则产物已生成却无人回收。
const IMG_TIMEOUT = (cfg) => (Number(cfg?.generation?.imageTimeoutMinutes) || 30) * 60 * 1000;
const VID_TIMEOUT = (cfg) => (Number(cfg?.generation?.videoTimeoutMinutes) || 90) * 60 * 1000;

// ================= 工具处理函数 =================
function chapterStats(ctx, title) {
  const shots = Shots.list(ctx.projectId).filter((s) => s.chapter === title);
  const done = shots.filter((s) => s.status === 'done').length;
  let gen = 'empty';
  if (shots.length) {
    if (done === shots.length) gen = 'done';
    else if (shots.some((s) => s.status === 'running')) gen = 'running';
    else if (shots.some((s) => s.status === 'failed')) gen = 'failed';
    else gen = 'pending';
  }
  return { total: shots.length, done, status: gen };
}
async function hGetProject(ctx) {
  const assets = Assets.list(ctx.projectId);
  const shots = Shots.list(ctx.projectId);
  return JSON.stringify({
    project: { id: ctx.project.id, name: ctx.project.name, style: ctx.project.style, video_resolution: ctx.project.video_resolution, video_aspect_ratio: ctx.project.video_aspect_ratio },
    context: ctx.project.context || {},
    chapters: Chapters.list(ctx.projectId).map((c) => { const st = chapterStats(ctx, c.title); return { id: c.id, title: c.title, seq: c.seq, status: c.status, novel: c.novel, shotCount: st.total, doneCount: st.done, genStatus: st.status }; }),
    assets: assets.map((a) => ({ id: a.id, category: a.category, name: a.name, image_path: a.image_path, voice_ref: a.voice_ref, parent_id: a.parent_id || '', status: a.status })),
    shots: shots.map((s) => ({ id: s.id, idx: s.idx, chapter: s.chapter || '', scene_name: s.scene_name, status: s.status, has_prompt: !!(s.video_prompt && String(s.video_prompt).trim()), video_path: s.video_path })),
  });
}
async function hListChapters(ctx) {
  return JSON.stringify(Chapters.list(ctx.projectId).map((c) => { const st = chapterStats(ctx, c.title); return { id: c.id, title: c.title, seq: c.seq, status: c.status, novel: c.novel, shotCount: st.total, doneCount: st.done, genStatus: st.status }; }));
}

async function hSaveContext(ctx, args) {
  const dir = path.join(projectDir(ctx.projectId), 'context');
  fs.mkdirSync(dir, { recursive: true });
  if (args.key === 'continuity') {
    const f = path.join(dir, 'continuity.json');
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    arr.push({ t: Date.now(), content: args.content });
    fs.writeFileSync(f, JSON.stringify(arr, null, 2));
  } else {
    const f = path.join(dir, args.key === 'bible' ? 'bible.md' : 'style.md');
    fs.writeFileSync(f, args.content);
  }
  const ctxObj = { ...(ctx.project.context || {}) };
  ctxObj[args.key] = args.content;
  Projects.update(ctx.projectId, { context: ctxObj });
  ctx.project.context = ctxObj;
  return '已保存上下文：' + args.key;
}

async function hLoadSkill(ctx, args) {
  const name = args.name;
  const skill = loadSkillWithResources(name);
  if (!skill) throw new Error('技能不存在：' + name);
  const NL = String.fromCharCode(10);
  const parts = [renderSkillContent(skill)];
  if (skill.references && skill.references.length) {
    parts.push('【技能参考文件索引】需要某个文件全文时，调用 skill_reference(name="' + name + '", ref="<文件名>")：');
    for (const r of skill.references) {
      const preview = String(r.content || '').slice(0, 160).replace(/\s+/g, ' ');
      parts.push('- ' + r.name + '（约 ' + r.content.length + ' 字）' + (preview ? '：' + preview : ''));
    }
  }
  const content = parts.join(NL + NL);
  return content.length > 120000 ? content.slice(0, 120000) + '…（截断）' : content;
}

async function hSkillReference(ctx, args) {
  const skill = loadSkillWithResources(args.name);
  if (!skill) throw new Error('技能不存在：' + args.name);
  const refs = skill.references || [];
  const ref = refs.find((r) => r.name === args.ref);
  if (!ref) throw new Error('参考文件不存在：' + args.ref + '。可用：' + refs.map((r) => r.name).join(', '));
  const content = String(ref.content || '');
  return content.length > 120000 ? content.slice(0, 120000) + '…（截断）' : content;
}

async function hReport(ctx, args) {
  ctx.report({ phase: args.phase || '', detail: args.detail || '' });
  return '已汇报';
}

async function hListAssets(ctx, args) {
  const assets = Assets.list(ctx.projectId, args.category);
  return JSON.stringify(assets.map((a) => ({ id: a.id, category: a.category, name: a.name, description: a.description, image_path: a.image_path, voice_ref: a.voice_ref, parent_id: a.parent_id || '', status: a.status })));
}

async function hCreateAsset(ctx, args) {
  // 幂等：同分类+同名资产已存在则复用，避免续跑时重复建
  const existing = Assets.list(ctx.projectId, args.category).find((a) => a.name === args.name);
  if (existing) return JSON.stringify({ id: existing.id, category: existing.category, name: existing.name, reused: true, status: existing.status, image_path: existing.image_path });
  const a = Assets.create(ctx.projectId, { category: args.category, name: args.name, description: args.description || '' });
  return JSON.stringify({ id: a.id, category: a.category, name: a.name });
}

async function hUpdateAsset(ctx, args) {
  const patch = {};
  for (const k of ['name', 'description', 'prompt', 'negative_prompt', 'voice_ref', 'consistency_key']) {
    if (args[k] != null) patch[k] = args[k];
  }
  Assets.update(args.id, patch);
  return '已更新资产 ' + args.id;
}

async function hGenerateAssetImage(ctx, args) {
  const asset = Assets.get(args.asset_id);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('资产不存在');
  const fb = assetFallback(asset, ctx.project);
  const prompt = args.prompt || asset.prompt || fb.prompt;
  const negative_prompt = args.negative_prompt ?? (asset.negative_prompt || fb.negative_prompt);
  // 按资产类型选合适尺寸：人物三视图/场景用 16:9，道具白底用 1:1，其余默认 16:9；可用参数 args.ratio 覆盖
  const RATIO_BY_CATEGORY = { character: '16:9', scene: '16:9', prop: '1:1', other: '16:9' };
  const ratio = args.ratio || RATIO_BY_CATEGORY[asset.category] || '16:9';
  const [w, h] = ratioToSize(ratio);
  const spec = getSpecForKind(ctx.cfg, 't2i');
  const prefix = 'assets/' + slugify(asset.name) + '_' + uid().slice(0, 8);
  ctx.report({ phase: '资产生成', detail: '文生图：' + asset.name });
  const { outputs } = await runWorkflow(ctx.cfg, spec, {
    positive_prompt: prompt, negative_prompt, width: w, height: h, seed: randomSeed(), filename_prefix: prefix,
  }, { timeoutMs: IMG_TIMEOUT(ctx.cfg), onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
  const img = pickOutput(outputs, 'images');
  if (!img) throw new Error('文生图工作流未返回图片');
  const ext = path.extname(img.filename) || '.png';
  const relDir = 'assets/' + PROJECT_ASSET_SUBDIRS[asset.category] + '/';
  const relPath = relDir + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  Assets.update(asset.id, { image_path: relPath, source: 'generated', prompt, negative_prompt, status: 'done' });
  return JSON.stringify({ asset_id: asset.id, image_path: relPath });
}

// 复用：以参考图跑 Qwen-Image-Edit 图生图，返回产物 { img, ext }（调用方负责下载落盘）
async function runI2iEdit(ctx, { refAbs, prompt, namePrefix, seed }) {
  const refName = 'ic_ref_' + ctx.projectId.slice(0, 8) + '_' + uid().slice(0, 8) + path.extname(refAbs);
  await uploadToInput(ctx.cfg.comfyui.baseUrl, refAbs, refName);
  const spec = getSpecForKind(ctx.cfg, 'i2i');
  const prefix = namePrefix || ('assets/edit_' + uid().slice(0, 8));
  const { outputs } = await runWorkflow(ctx.cfg, spec, {
    positive_prompt: prompt, image: refName, seed: seed ?? randomSeed(), filename_prefix: prefix,
  }, { timeoutMs: IMG_TIMEOUT(ctx.cfg), onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
  const img = pickOutput(outputs, 'images');
  if (!img) throw new Error('图生图工作流未返回图片');
  return { img, ext: path.extname(img.filename) || '.png' };
}

async function hEditAssetImage(ctx, args) {
  const asset = Assets.get(args.asset_id);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('资产不存在');
  const refAsset = args.reference_asset_id ? Assets.get(args.reference_asset_id) : asset;
  const refAbs = resolveProjectPath(ctx.projectId, refAsset?.image_path);
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('参考图不存在，请先生成/上传参考图');
  const fb = assetFallback(asset, ctx.project);
  const prompt = args.prompt || asset.prompt || fb.prompt;
  ctx.report({ phase: '资产生成', detail: '图生图：' + asset.name });
  const { img, ext } = await runI2iEdit(ctx, { refAbs, prompt, namePrefix: 'assets/' + slugify(asset.name) + '_edit_' + uid().slice(0, 8) });
  const relDir = 'assets/' + PROJECT_ASSET_SUBDIRS[asset.category] + '/';
  const relPath = relDir + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  // 追加版本，仍以最新为准
  const versions = [...(asset.versions || []), asset.image_path].filter(Boolean);
  Assets.update(asset.id, { image_path: relPath, source: 'generated', prompt, versions, status: 'done' });
  return JSON.stringify({ asset_id: asset.id, image_path: relPath });
}

async function hChangeOutfit(ctx, args) {
  const char = Assets.get(args.character_id);
  if (!char || char.project_id !== ctx.projectId) throw new Error('角色资产不存在');
  if (char.category !== 'character') throw new Error('change_outfit 只能对角色（character）资产使用');
  const refAbs = resolveProjectPath(ctx.projectId, char.image_path);
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('角色参考图不存在，请先生成/上传角色 canonical 图');
  const outfit = String(args.outfit || '').trim();
  if (!outfit) throw new Error('请提供 outfit（服装描述）');
  const label = String(args.label || '').trim();
  const name = char.name + '-' + (label || outfit);
  // 幂等：同角色同名服装已 done 则复用
  const existing = Assets.list(ctx.projectId, 'costume').find((a) => a.parent_id === char.id && a.name === name && a.status === 'done' && a.image_path);
  if (existing) return JSON.stringify({ costume_id: existing.id, image_path: existing.image_path, parent_id: existing.parent_id, reused: true });

  let prompt = args.prompt;
  if (!prompt) {
    const base = 'Keep the character identity, face, hairstyle, expression and art style exactly the same as the reference image; change only the clothing to: ' + outfit + '. Keep the pose and background unchanged.';
    if (visionEnabled(ctx) && ctx.cfg.llm?.apiKey) {
      try {
        const img = imageToDataUrl(refAbs);
        const dataUrls = img ? ['data:' + img.mimeType + ';base64,' + img.data] : [];
        const r = await llmChat(ctx.cfg.llm, [
          { role: 'system', content: '你是图生图（Qwen-Image-Edit）换装提示词专家。基于参考图与服装描述，输出一段英文编辑指令：保持角色身份/脸部/发型/画风一致，只更换服装；不要输出任何解释，只输出指令文本。' },
          buildVisionUserMessage('参考图如下。请为以下服装写英文图生图换装指令：' + outfit, dataUrls),
        ], { temperature: 0.5, maxTokens: 400 });
        prompt = (r.content || '').trim() || base;
      } catch (e) { logger.warn('换装视觉精修失败，用默认指令', { error: e.message }); prompt = base; }
    } else {
      prompt = base;
    }
  }

  ctx.report({ phase: '人物换装', detail: '为 ' + char.name + ' 生成服装「' + outfit + '」（图生图）' });
  const { img, ext } = await runI2iEdit(ctx, { refAbs, prompt, namePrefix: 'assets/costume_' + slugify(char.name) + '_' + uid().slice(0, 8) });
  const relPath = 'assets/' + PROJECT_ASSET_SUBDIRS.costume + '/' + slugify(name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  const costume = Assets.create(ctx.projectId, { category: 'costume', name, description: outfit, prompt, parent_id: char.id });
  Assets.update(costume.id, { image_path: relPath, source: 'generated', status: 'done' });
  return JSON.stringify({ costume_id: costume.id, image_path: relPath, parent_id: char.id, prompt });
}

// 一次性给角色设计并生成多套服装（衣橱）：复用 change_outfit 的图生图换装，逐套生成服装资产
async function hDesignOutfits(ctx, args) {
  const char = Assets.get(args.character_id);
  if (!char || char.project_id !== ctx.projectId) throw new Error('角色资产不存在');
  if (char.category !== 'character') throw new Error('design_outfits 只能对角色（character）资产使用');
  const outfits = Array.isArray(args.outfits) ? args.outfits : [];
  if (!outfits.length) throw new Error('请提供 outfits（该角色的多套服装清单）');
  const results = [];
  for (const o of outfits) {
    const name = String((o && o.name) || '').trim();
    const description = String((o && o.description) || name || '').trim();
    if (!description) continue;
    try {
      const r = await hChangeOutfit(ctx, { character_id: char.id, outfit: description, label: name });
      results.push({ name: name || description, ...JSON.parse(r) });
    } catch (e) {
      logger.warn('design_outfits 单套生成失败：' + (name || description), { error: e.message });
      results.push({ name: name || description, error: e.message });
    }
  }
  const okCount = results.filter((r) => !r.error).length;
  ctx.report({ phase: '人物换装', detail: '为 ' + char.name + ' 设计衣橱：生成 ' + okCount + '/' + outfits.length + ' 套服装' });
  return JSON.stringify({ character_id: char.id, character_name: char.name, costumes: results });
}

async function hViewAsset(ctx, args) {
  const a = Assets.get(args.asset_id);
  if (!a || a.project_id !== ctx.projectId) throw new Error('资产不存在');
  const text = JSON.stringify({ id: a.id, category: a.category, name: a.name, description: a.description, image_path: a.image_path, parent_id: a.parent_id || '', status: a.status });
  if (!visionEnabled(ctx)) return text + '（当前模型不支持图片输入，仅返回文本描述）';
  const abs = resolveProjectPath(ctx.projectId, a.image_path);
  const images = imagesFromPaths([abs], 1);
  return images.length ? { text, images } : text + '（该资产暂无参考图）';
}

async function hViewShotReferences(ctx, args) {
  const shot = Shots.get(args.shot_id);
  if (!shot || shot.project_id !== ctx.projectId) throw new Error('分镜不存在');
  const assets = Assets.list(ctx.projectId);
  const byId = (id) => assets.find((x) => x.id === id);
  const chars = (shot.character_ids || []).map(byId).filter(Boolean);
  const scenes = (shot.scene_ids || []).map(byId).filter(Boolean);
  const props = (shot.prop_ids || []).map(byId).filter(Boolean);
  const costumes = (shot.costume_ids || []).map(byId).filter(Boolean);
  const text = JSON.stringify({
    characters: chars.map((c) => ({ id: c.id, name: c.name, image_path: c.image_path })),
    scenes: scenes.map((s) => ({ id: s.id, name: s.name, image_path: s.image_path })),
    props: props.map((p) => ({ id: p.id, name: p.name, image_path: p.image_path })),
    costumes: costumes.map((c) => ({ id: c.id, name: c.name, image_path: c.image_path, parent_id: c.parent_id || '' })),
  });
  if (!visionEnabled(ctx)) return text + '（当前模型不支持图片输入，仅返回文本清单）';
  const absPaths = [...chars, ...scenes, ...props, ...costumes].map((x) => resolveProjectPath(ctx.projectId, x.image_path)).filter(Boolean);
  const images = imagesFromPaths(absPaths, 6);
  return images.length ? { text, images } : text + '（该分镜暂无参考图）';
}

async function hRegisterVoice(ctx, args) {
  Assets.update(args.asset_id, { voice_ref: args.voice_ref });
  return '已登记参考语音';
}

async function hDesignVoice(ctx, args) {
  const asset = Assets.get(args.asset_id);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('资产不存在');
  let text = (args.text || '').trim() || asset.description || ('你好，我是' + asset.name + '。很高兴认识你。');
  // 朗读文案控制在 20~30 字（约 5 秒自我介绍），超长截断，避免生成过长的音色样本
  const MAX_TTS_TEXT = 30;
  if (text.length > MAX_TTS_TEXT) {
    logger.warn('音色设计朗读文案过长（' + text.length + ' 字），已截断到 ' + MAX_TTS_TEXT + ' 字：' + asset.name);
    text = text.slice(0, MAX_TTS_TEXT);
  }
  const voice_description = args.voice_description || asset.description || '自然清晰的中文语音';
  const spec = getSpecForKind(ctx.cfg, 'tts');
  const prefix = 'voice/' + slugify(asset.name) + '_' + uid().slice(0, 8);
  ctx.report({ phase: '音色设计', detail: '设计音色：' + asset.name });
  const { outputs } = await runWorkflow(ctx.cfg, spec, {
    text, voice_description, seed: randomSeed(), filename_prefix: prefix,
  }, { timeoutMs: IMG_TIMEOUT(ctx.cfg), onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
  const aud = pickOutput(outputs, 'audio');
  if (!aud) throw new Error('音色设计工作流未返回音频');
  const ext = path.extname(aud.filename) || '.wav';
  const relPath = 'assets/voice/' + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, aud, relPath);
  Assets.update(asset.id, { voice_ref: relPath, audio_path: relPath, source: 'generated', status: 'done' });
  return JSON.stringify({ asset_id: asset.id, voice_ref: relPath });
}

// 按工作流分批统一生成：① 文生图全部图片资产 → ② Qwen3-TTS 全部人物音色（同一工作流连续跑完再切下一类，省模型加载）
async function hGenerateAssetsBatch(ctx) {
  const assets = Assets.list(ctx.projectId);
  const imageCats = ['character', 'scene', 'prop', 'other'];
  const imageAssets = assets.filter((a) => imageCats.includes(a.category));
  const charAssets = assets.filter((a) => a.category === 'character');
  const res = { images: { total: 0, generated: 0, failed: 0 }, voices: { total: 0, generated: 0, failed: 0 } };

  ctx.report({ phase: '资产生成', detail: '第1批·文生图：连续生成 ' + imageAssets.length + ' 个图片资产（同一工作流不切换）' });
  for (const a of imageAssets) {
    if (a.image_path && a.status === 'done') continue;
    res.images.total++;
    try { await hGenerateAssetImage(ctx, { asset_id: a.id }); res.images.generated++; }
    catch (e) { res.images.failed++; ctx.report({ phase: '资产生成', detail: '图片失败 ' + a.name + '：' + e.message }); }
  }

  ctx.report({ phase: '音色设计', detail: '第2批·音色设计：连续设计 ' + charAssets.length + ' 个角色音色（同一工作流不切换）' });
  for (const a of charAssets) {
    if (a.voice_ref && fs.existsSync(resolveProjectPath(ctx.projectId, a.voice_ref))) continue;
    res.voices.total++;
    try { await hDesignVoice(ctx, { asset_id: a.id }); res.voices.generated++; }
    catch (e) { res.voices.failed++; ctx.report({ phase: '音色设计', detail: '音色失败 ' + a.name + '：' + e.message }); }
  }

  return JSON.stringify(res);
}

// —— 换装事件自动识别与服装资产生成（确定性兜底，不依赖 LLM 记忆） ——
// 剧情里的「沐浴/洗澡/更衣/换衣/换装」意味着角色着装状态发生变化（洗澡后理应换干净衣服）。
// 系统据此自动为对应角色生成一套服装资产（change_outfit，图生图保持脸/发型/画风一致），
// 并自动绑定到「换装事件之后」的镜头；事件之前的镜头继续用角色原图或旧服装。
const OUTFIT_BATH_RE = /沐浴|洗澡|浴桶|沐浴更衣/;
const OUTFIT_CHANGE_RE = /更衣|换衣|换装|换衣服|换了衣服|换上了|换上一身|换了一身|换上一套|换了一套|换上新衣|换上新裳|换上新衣裳/;

function detectOutfitChange(text) {
  if (!text) return null;
  const m = String(text).match(OUTFIT_BATH_RE);
  if (m) return { kind: 'bath', keyword: m[0] };
  const c = String(text).match(OUTFIT_CHANGE_RE);
  if (c) return { kind: 'change', keyword: c[0] };
  return null;
}

function inferOutfitDescription(text, kind, keyword) {
  if (kind === 'bath') return '沐浴后换上的干净衣裳';
  if (kind === 'change') {
    const t = String(text);
    const i = t.indexOf(keyword);
    if (i >= 0) {
      let seg = t.slice(i + keyword.length, i + keyword.length + 16);
      seg = seg.replace(/^[的了过，。；：!！?？]+/, '').trim();
      const cut = seg.search(/[，。；：!！?？]/);
      if (cut >= 0) seg = seg.slice(0, cut);
      if (seg.trim()) return seg.trim();
    }
    return '新换的衣裳';
  }
  return '新换的衣裳';
}

// 扫描本次写入分镜所属章节的换装事件，自动生成服装资产并绑定到事件之后的镜头。
// 幂等：同名服装已存在则复用（change_outfit 内部去重）；生成失败不阻塞分镜写入（该镜继续用角色原图兜底）。
async function autoResolveOutfits(ctx, chapters) {
  const chapterSet = new Set((chapters || []).filter(Boolean).map(String));
  if (!chapterSet.size) return { generated: 0, bound: 0, notes: [] };
  const shots = Shots.list(ctx.projectId)
    .filter((s) => chapterSet.has(String(s.chapter || '')))
    .sort((a, b) => String(a.chapter || '').localeCompare(String(b.chapter || ''), 'zh') || (a.idx - b.idx));
  if (!shots.length) return { generated: 0, bound: 0, notes: [] };

  const assets = Assets.list(ctx.projectId);
  const charById = {};
  for (const a of assets) if (a.category === 'character') charById[a.id] = a;

  const currentCostume = {};   // charId -> costumeId（本章内当前着装）
  let prevChapter = null;
  let generated = 0, bound = 0;
  const notes = [];
  const textOf = (s) => [s.scene_name, s.visual, s.dialogue, s.sub_shots].filter(Boolean).join(' ');

  for (const s of shots) {
    // 章节边界：重置「当前着装」状态（换装跟随剧情在同一章内连续）
    if (prevChapter !== null && s.chapter !== prevChapter) { for (const k of Object.keys(currentCostume)) delete currentCostume[k]; }
    prevChapter = s.chapter;

    const charIds = (s.character_ids || []).filter((id) => charById[id]);
    const text = textOf(s);
    const costumeIds = new Set(s.costume_ids || []);

    // 1) 先应用当前着装到本镜（若此前已发生换装）
    for (const cid of charIds) if (currentCostume[cid]) costumeIds.add(currentCostume[cid]);

    // 2) 检测本镜是否发生换装事件，归属到具体角色并生成服装资产（自下一镜起生效）
    const evt = detectOutfitChange(text);
    if (evt) {
      for (const cid of charIds) {
        const char = charById[cid];
        const named = charIds.length === 1 || text.includes(char.name);
        if (!named) continue;
        const outfit = inferOutfitDescription(text, evt.kind, evt.keyword);
        try {
          const r = await hChangeOutfit(ctx, { character_id: cid, outfit });
          const info = JSON.parse(r);
          currentCostume[cid] = info.costume_id;
          generated++;
          notes.push('自动换装：' + char.name + ' → ' + outfit);
        } catch (e) {
          logger.warn('自动换装失败：' + char.name + '（' + outfit + '）', { error: e.message });
          notes.push('自动换装失败：' + char.name + '（' + e.message + '）');
        }
      }
    }

    // 3) 写回本镜 costume_ids（含新生成/复用的服装）
    const existing = [...(s.costume_ids || [])].sort();
    const next = [...costumeIds].sort();
    if (JSON.stringify(existing) !== JSON.stringify(next)) {
      Shots.update(s.id, { costume_ids: next });
      bound++;
    }
  }
  return { generated, bound, notes };
}

async function hSetStoryboard(ctx, args) {
  // 台词时长校验：中文旁白约 4-5 字/秒，超速会被 H3/TTS 压缩成听不清的模糊声。
  // 硬性拒绝，强制 Agent 缩短台词或拆分镜头，而不是生成后才发现语音对不上。
  const MAX_RATE = 5.5; // 字/秒（含说话人前缀「醉天：」的余量）
  const over = [];
  for (const sb of args.shots || []) {
    const dur = Math.min(15, Math.max(1, sb.duration || 8));
    const chars = (sb.dialogue || '').length;
    if (chars && chars / dur > MAX_RATE) {
      over.push({ idx: sb.idx, durationSec: dur, dialogueChars: chars, maxChars: Math.floor(dur * MAX_RATE) });
    }
  }
  if (over.length) {
    throw new Error('台词与时长不匹配：中文旁白约 4-5 字/秒，超出会被压缩成听不清的模糊声。请把以下镜头的台词缩短到 maxChars 字以内（或拆成更多镜头 / 延长到最长 15 秒）：' + JSON.stringify(over));
  }
  // 多人对话校验：单分镜最多 MAX_SPEAKERS_PER_SHOT 个说话人；≥3 人对话必须拆成多个分镜，
  // 避免参考音频超限（每说话人一段参考音色）且避免多人同框对话质量下降。
  const multiSpeaker = [];
  for (const sb of args.shots || []) {
    const speakers = dialogueSpeakerNames(sb.dialogue);
    if (speakers.length > MAX_SPEAKERS_PER_SHOT) {
      multiSpeaker.push({ idx: sb.idx, speakers });
    }
  }
  if (multiSpeaker.length) {
    throw new Error('分镜对话人数过多：每个分镜最多 ' + MAX_SPEAKERS_PER_SHOT + ' 个说话人，请把多人对话拆成多个分镜（每个分镜最多 ' + MAX_SPEAKERS_PER_SHOT + ' 人说话）。涉及分镜：' + JSON.stringify(multiSpeaker));
  }
  const assets = Assets.list(ctx.projectId);
  const byName = (cat) => {
    const m = {};
    for (const a of assets) if (a.category === cat) m[a.name] = a.id;
    return m;
  };
  const charMap = byName('character'); const sceneMap = byName('scene'); const propMap = byName('prop'); const costumeMap = byName('costume');
  let existing = Shots.list(ctx.projectId);
  if (args.clear) { for (const s of existing) Shots.remove(s.id); existing = []; }
  // 每章独立 idx 空间：同一 (chapter, idx) 视为同一个镜头，不同章节互不干扰
  const key = (ch, idx) => String(ch || '') + '\u0000' + String(idx);
  const byKey = {}; for (const s of existing) byKey[key(s.chapter, s.idx)] = s;
  const chapterMax = {}; for (const s of existing) chapterMax[s.chapter || ''] = Math.max(chapterMax[s.chapter || ''] || 0, s.idx);
  let added = 0, updated = 0;
  const touched = [];
  for (const sb of args.shots || []) {
    const ch = sb.chapter || '';
    let idx = sb.idx;
    if (idx == null) { idx = (chapterMax[ch] || 0) + 1; chapterMax[ch] = idx; }
    const fields = {
      chapter: ch,
      scene_name: sb.scene_name || ((sb.scenes || []).join('、')),
      camera: sb.camera || '', visual: sb.visual || '', dialogue: sb.dialogue || '',
      sub_shots: sb.sub_shots || '', duration: Math.min(15, Math.max(1, sb.duration || 8)),
      character_ids: (sb.characters || []).map((n) => charMap[n]).filter(Boolean),
      scene_ids: (sb.scenes || []).map((n) => sceneMap[n]).filter(Boolean),
      prop_ids: (sb.props || []).map((n) => propMap[n]).filter(Boolean),
      costume_ids: (sb.costumes || []).map((n) => costumeMap[n]).filter(Boolean),
      resolution: ctx.project.video_resolution || '480P',
      aspect_ratio: ctx.project.video_aspect_ratio || '16:9',
    };
    const k = key(ch, idx);
    if (byKey[k] !== undefined) {
      Shots.update(byKey[k].id, fields);
      updated++;
      touched.push({ id: byKey[k].id, idx, reused: true });
    } else {
      const shot = Shots.create(ctx.projectId, { ...fields, idx });
      added++;
      touched.push({ id: shot.id, idx: shot.idx });
    }
  }
  // 非破坏：仅新增/更新，绝不自动删除既有分镜（保证旧章节保留，多章节可继续追加）
  // 换装兜底：识别本次写入章节内的沐浴/更衣/换装事件，自动生成服装资产并绑定到事件之后的镜头
  const chapters = [...new Set((args.shots || []).map((s) => s.chapter || ''))];
  const outfitRes = await autoResolveOutfits(ctx, chapters);
  if (outfitRes.generated) ctx.report({ phase: '人物换装', detail: '自动识别换装事件，生成服装资产 ' + outfitRes.generated + ' 套' });
  let out = '分镜已写入（新增 ' + added + '，更新 ' + updated + '）';
  if (outfitRes.generated) out += '；自动换装生成服装资产 ' + outfitRes.generated + ' 套、绑定 ' + outfitRes.bound + ' 镜';
  return out;
}

async function hListShots(ctx) {
  return JSON.stringify(Shots.list(ctx.projectId).map((s) => ({ id: s.id, idx: s.idx, chapter: s.chapter || '', scene_name: s.scene_name, status: s.status, has_prompt: !!(s.video_prompt && String(s.video_prompt).trim()), has_video: !!s.video_path, error: s.error, duration: s.duration })));
}

async function hUpdateShot(ctx, args) {
  const patch = {};
  for (const k of ['sub_shots', 'dialogue', 'camera', 'visual', 'duration', 'video_prompt']) if (args[k] != null) patch[k] = args[k];
  // 若本次修改了台词或时长，同样做「台词字数 ≤ 时长×5」校验
  if (args.dialogue != null || args.duration != null) {
    const shot = Shots.get(args.shot_id);
    if (shot) {
      const dur = Math.min(15, Math.max(1, patch.duration != null ? patch.duration : (shot.duration || 8)));
      const chars = (patch.dialogue != null ? patch.dialogue : (shot.dialogue || '')).length;
      if (chars && chars / dur > 5.5) {
        throw new Error('台词与时长不匹配：中文旁白约 4-5 字/秒，当前 ' + chars + ' 字 / ' + dur + ' 秒（上限 ' + Math.floor(dur * 5.5) + ' 字）超速，会被压缩成听不清的模糊声。请缩短台词或延长时长。');
      }
    }
  }
  // 若本次修改了台词，校验说话人数 ≤ MAX_SPEAKERS_PER_SHOT（多人对话需拆镜）
  if (args.dialogue != null) {
    const speakers = dialogueSpeakerNames(patch.dialogue);
    if (speakers.length > MAX_SPEAKERS_PER_SHOT) {
      throw new Error('分镜对话人数过多：每个分镜最多 ' + MAX_SPEAKERS_PER_SHOT + ' 个说话人，请拆成多个分镜。当前说话人：' + speakers.join('、'));
    }
  }
  Shots.update(args.shot_id, patch);
  return '已更新分镜';
}

function shotImageAbsPaths(ctx, shot) {
  const assets = Assets.list(ctx.projectId);
  const byId = (id) => assets.find((x) => x.id === id);
  const ids = [...(shot.character_ids || []), ...(shot.scene_ids || []), ...(shot.prop_ids || []), ...(shot.costume_ids || [])];
  return ids.map(byId).filter(Boolean).map((a) => resolveProjectPath(ctx.projectId, a.image_path)).filter(Boolean);
}

async function rewritePromptWithFeedback(ctx, basePrompt, feedback, imageAbsPaths) {
  const msgs = [
    { role: 'system', content: '你是视频提示词改写助手。基于原提示词与用户反馈，输出改写后的完整提示词（中文，保留 __MINIMAX_H3_REF_N__ 占位符与参考标签不变）。只输出提示词文本。' },
  ];
  if (visionEnabled(ctx)) {
    const dataUrls = imagesFromPaths(imageAbsPaths, 9).map((i) => 'data:' + i.mimeType + ';base64,' + i.data);
    msgs.push(buildVisionUserMessage('原提示词：\n' + basePrompt + '\n\n反馈：' + feedback + '\n\n（附该分镜参考图，供改写参考）', dataUrls));
  } else {
    msgs.push({ role: 'user', content: '原提示词：\n' + basePrompt + '\n\n反馈：' + feedback });
  }
  const r = await llmChat(ctx.cfg.llm, msgs, { temperature: 0.6, maxTokens: 1200 });
  return (r.content || '').trim() || basePrompt;
}

async function generateShotVideo(ctx, shotId, { feedback } = {}) {
  const shot = Shots.get(shotId);
  if (!shot || shot.project_id !== ctx.projectId) throw new Error('分镜不存在');
  const assets = Assets.list(ctx.projectId);
  const { references, characterName, characterDesc, sceneDesc } = await assembleShotReferences({ cfg: ctx.cfg, project: ctx.project, shot, assets });
  const timeErr = validateSubShots(shot.duration, shot.sub_shots);
  if (timeErr) throw new Error(timeErr);
  const base = shot.video_prompt || fallbackVideoPrompt({ references, style: ctx.project.style, characterDesc, sceneDesc, subShots: shot.sub_shots, camera: shot.camera, visual: shot.visual, dialogue: shot.dialogue, characterName });
  const prompt = feedback ? await rewritePromptWithFeedback(ctx, base, feedback, shotImageAbsPaths(ctx, shot)) : base;
  const spec = getSpecForKind(ctx.cfg, 'r2v');
  const seed = randomSeed();
  const reso = shot.resolution || ctx.project.video_resolution || '480P';
  const ratio = shot.aspect_ratio || ctx.project.video_aspect_ratio || '16:9';
  const prefix = 'video/' + ctx.projectId.slice(0, 8) + '_shot' + shot.idx + '_' + uid().slice(0, 6);
  Shots.update(shot.id, { status: 'generating', video_prompt: prompt, seed, resolution: reso, aspect_ratio: ratio, error: '', prompt_id: '' });
  ctx.report({ phase: '分镜视频', detail: '生成分镜 ' + shot.idx + (feedback ? '（重生成）' : '') });
  const wfParams = {
    positive_prompt: prompt,
    seconds: shot.duration || 5,
    aspect_ratio: ratio,
    resolution: reso,
    seed, filename_prefix: prefix, references,
  };
  // 自定义分辨率：resolution 固定为 custom，宽高取自项目配置
  if (reso === 'custom') {
    wfParams.width = Number(ctx.project.video_width) || 1024;
    wfParams.height = Number(ctx.project.video_height) || 576;
  }
  const { outputs, prompt_id } = await runWorkflow(ctx.cfg, spec, wfParams, { timeoutMs: VID_TIMEOUT(ctx.cfg), onSubmitted: (pid) => Shots.update(shot.id, { prompt_id: pid }), onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
  const vid = pickOutput(outputs, 'videos');
  if (!vid) throw new Error('视频工作流未返回视频文件');
  const ext = path.extname(vid.filename) || '.mp4';
  const relPath = 'shots/shot' + shot.idx + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, vid, relPath);
  Shots.update(shot.id, { video_path: relPath, status: 'done', error: '', prompt_id: '' });
  return JSON.stringify({ shot_id: shot.id, idx: shot.idx, video_path: relPath, prompt_id });
}

async function hGenerateShotVideo(ctx, args) { return generateShotVideo(ctx, args.shot_id); }
async function hRegenerateShot(ctx, args) { return generateShotVideo(ctx, args.shot_id, { feedback: args.feedback }); }
async function hGenerateChapterVideos(ctx, args) {
  const title = (args && args.chapter) || ctx.chapter;
  const force = !!(args && args.force);
  if (!title) throw new Error('请指定章节 chapter');
  const all = Shots.list(ctx.projectId).filter((s) => s.chapter === title);
  if (!all.length) return JSON.stringify({ chapter: title, total: 0, generated: 0, remaining: 0, note: '本章没有分镜' });
  const target = force ? all : all.filter((s) => s.status !== 'done');
  const runCount = target.length;
  let ok = 0, fail = 0;
  for (let i = 0; i < target.length; i++) {
    const s = target[i];
    if (ctx.isAborted && ctx.isAborted()) return JSON.stringify({ chapter: title, total: all.length, generated: ok, failed: fail, remaining: Shots.list(ctx.projectId).filter((x) => x.chapter === title && x.status !== 'done').length, aborted: true });
    ctx.report({ phase: '分镜视频', detail: '生成 ' + s.idx + '/' + runCount + '（' + (ok + fail) + '/' + runCount + ' 已处理）' });
    try {
      await generateShotVideo(ctx, s.id, {});
      ok++;
    } catch (e) {
      fail++;
      Shots.update(s.id, { status: 'failed', error: String(e.message) });
    }
  }
  const remaining = Shots.list(ctx.projectId).filter((s) => s.chapter === title && s.status !== 'done').length;
  return JSON.stringify({ chapter: title, total: all.length, generated: ok, failed: fail, remaining });
}

async function hAssembleVideo(ctx) {
  const done = Shots.list(ctx.projectId).filter((s) => s.video_path && s.status === 'done');
  if (!done.length) throw new Error('没有已完成的分镜视频');
  const inputs = done.map((s) => resolveProjectPath(ctx.projectId, s.video_path)).filter(Boolean);
  const outRel = 'exports/' + slugify(ctx.project.name) + '_' + uid().slice(0, 8) + '.mp4';
  const outAbs = resolveProjectPath(ctx.projectId, outRel);
  ctx.report({ phase: '导出', detail: '合并 ' + inputs.length + ' 段视频' });
  await mergeVideos(inputs, outAbs, {});
  return JSON.stringify({ export_path: outRel, shots: done.length });
}

async function hListWorkflows() {
  return JSON.stringify(Workflows.list().map((w) => ({ id: w.id, name: w.name, kind: w.kind, sourceFile: w.sourceFile })));
}

const HANDLERS = {
  get_project: hGetProject,
  save_context: hSaveContext,
  skill: hLoadSkill,
  skill_reference: hSkillReference,
  report: hReport,
  list_chapters: hListChapters,
  list_assets: hListAssets,
  create_asset: hCreateAsset,
  update_asset: hUpdateAsset,
  generate_asset_image: hGenerateAssetImage,
  edit_asset_image: hEditAssetImage,
  change_outfit: hChangeOutfit,
  design_outfits: hDesignOutfits,
  view_asset: hViewAsset,
  view_shot_references: hViewShotReferences,
  register_voice: hRegisterVoice,
  design_voice: hDesignVoice,
  generate_assets_batch: hGenerateAssetsBatch,
  set_storyboard: hSetStoryboard,
  list_shots: hListShots,
  update_shot: hUpdateShot,
  generate_shot_video: hGenerateShotVideo,
  regenerate_shot: hRegenerateShot,
  generate_chapter_videos: hGenerateChapterVideos,
  assemble_video: hAssembleVideo,
  list_workflows: hListWorkflows,
};

export async function runTool(ctx, name, args) {
  const h = HANDLERS[name];
  if (!h) throw new Error('未知工具：' + name);
  logger.debug('agent tool', { name, args });
  return await h(ctx, args || {});
}
