import fs from 'node:fs';
import path from 'node:path';
import { WORKFLOWS_DIR } from './config.js';

// —— 三个默认工作流的「工作流规格」（hand-written，保证语义角色准确） ——
export const DEFAULT_SPECS = [
  {
    id: 'minimax_h3_r2v',
    kind: 'r2v',
    name: 'MiniMax H3 Ref2VA 视频',
    description: '参考图/参考音生成带语音的视频（MiniMax H3 Easy 全能参考范式）',
    sourceFile: 'MiniMax_H3_Easy_r2v.json',
    roles: {
      positive_prompt: { node: '2', field: 'prompt' },
      seconds: { node: '2', field: 'seconds' },
      resolution: { node: '2', field: 'resolution' },
      aspect_ratio: { node: '2', field: 'aspect_ratio' },
      width: { node: '2', field: 'width' },
      height: { node: '2', field: 'height' },
      seed: { node: '6', field: 'noise_seed' },
      filename_prefix: { node: '12', field: 'filename_prefix' },
    },
    media: {
      targetNode: '2',
      mediaField: 'media_',
      typeField: 'media_type_',
      loaders: { image: { class: 'LoadImage', field: 'image' }, audio: { class: 'LoadAudio', field: 'audio' }, video: { class: 'LoadVideo', field: 'file' } },
      reusePool: { image: ['15', '32'], audio: ['26'], video: [] },
      maxImages: 9,
      maxAudioVideo: 3,
    },
    outputs: ['SaveVideo', 'SaveImage'],
  },
  {
    id: 'krea2_hyperreal_t2i',
    kind: 't2i',
    name: 'Krea2 超写实文生图',
    description: '文生图（Krea2 Hyperreal，超写实 8K，支持角色三视图设定图）',
    sourceFile: 'krea2_hyperreal_2608.json',
    roles: {
      positive_prompt: { node: '102', field: 'text' },
      width: { node: '100', field: 'width' },
      height: { node: '100', field: 'height' },
      seed: { node: '96', field: 'seed' },
      filename_prefix: { node: '95', field: 'filename_prefix' },
    },
    outputs: ['SaveImage'],
  },
  {
    id: 'qwen_image_edit_2511_i2i',
    kind: 'i2i',
    name: 'Qwen-Image-Edit-2511 图生图',
    description: '图生图/图像编辑（Qwen-Image-Edit-2511，参考图 + 编辑指令）',
    sourceFile: 'image_qwen_image_edit_2511_i2i.json',
    roles: {
      positive_prompt: { node: '170:151', field: 'prompt' },
      seed: { node: '170:169', field: 'seed' },
      image: { node: '41', field: 'image' },
      filename_prefix: { node: '9', field: 'filename_prefix' },
    },
    outputs: ['SaveImage'],
  },
  // —— 本机 GGUF 量化版（适配本机 ComfyUI：GGUF unet + Qwen-Image 2.1 + H3 8B） ——
  {
    id: 'qwen_image_2_1_t2i_gguf',
    kind: 't2i',
    name: 'Qwen-Image 2.1 文生图 (GGUF Q8_0)',
    description: '文生图（Qwen-Image 2.1 GGUF Q8_0 量化版，本机显卡适配）',
    sourceFile: 'qwen_image_2_1_t2i-Q8_0_gguf.json',
    roles: {
      // prompt 走 TextEncodeQwenImage21（真正喂给采样器的编码节点），覆盖模板里 TextGenerate 扩写链的连线
      positive_prompt: { node: '459:452', field: 'prompt' },
      negative_prompt: { node: '459:452', field: 'negative_prompt' },
      width: { node: '459:456', field: 'width' },
      height: { node: '459:456', field: 'height' },
      seed: { node: '459:458', field: 'seed' },
      filename_prefix: { node: '461', field: 'filename_prefix' },
    },
    // 模板自带的 LLM 提示词扩写链（TextGenerate/PreviewAny/PrimitiveStringMultiline）：prompt 被直写后即孤立
    prune: ['459:471', '459:472', '459:475'],
    outputs: ['SaveImageAdvanced'],
  },
  {
    id: 'qwen_image_2_1_i2i_gguf',
    kind: 'i2i',
    name: 'Qwen-Image 2.1 图生图 (GGUF Q8_0)',
    description: '图生图/图像编辑（Qwen-Image 2.1 GGUF Q8_0 量化版，参考图 + 编辑指令）',
    sourceFile: 'qwen_image_2_1_image_edit-Q8_0_gguf.json',
    roles: {
      positive_prompt: { node: '459:474', field: 'prompt' },
      negative_prompt: { node: '459:474', field: 'negative_prompt' },
      image: { node: '470', field: 'image' },
      seed: { node: '459:458', field: 'seed' },
      filename_prefix: { node: '461', field: 'filename_prefix' },
    },
    // 475 是模板里第二张参考图（服装图），本流程只传一张：留着会因文件不存在被 ComfyUI 拒
    prune: ['475'],
    outputs: ['SaveImageAdvanced'],
  },
  {
    id: 'minimax_h3_r2v_gguf',
    kind: 'r2v',
    name: 'MiniMax H3 参考转视频 (GGUF 8B)',
    description: '参考图/参考音生成带语音的视频（MiniMax H3 8B GGUF 量化版，本机显卡适配）',
    sourceFile: 'minimax_h3_ref2v-gguf-8b-heretic-op.json',
    roles: {
      positive_prompt: { node: '145', field: 'prompt' },
      // 时长注入 135（PrimitiveFloat）而非 145.length，保留 134 的 17k+5 帧对齐表达式
      seconds: { node: '135', field: 'value' },
      aspect_ratio: { node: '115', field: 'aspect_ratio', map: {
        '1:1': '1:1 (Square)', '2:3': '2:3 (Portrait Photo)', '3:2': '3:2 (Photo)',
        '3:4': '3:4 (Portrait Standard)', '4:3': '4:3 (Standard)',
        '9:16': '9:16 (Portrait Widescreen)', '16:9': '16:9 (Widescreen)', '21:9': '21:9 (Ultrawide)',
      } },
      // 项目里的 480P/720P/1080P 标签 → ResolutionSelector 的 megapixels 目标
      resolution: { node: '115', field: 'megapixels', map: { '480P': 0.5, '720P': 1, '1080P': 2, '2K': 2, '4K': 4 } },
      // custom 分辨率由 width/height 直写 145，此时 115 ResolutionSelector 变孤立并被剪掉
      width: { node: '145', field: 'width' },
      height: { node: '145', field: 'height' },
      seed: { node: '131', field: 'noise_seed' },
      filename_prefix: { node: '92', field: 'filename_prefix' },
    },
    media: {
      targetNode: '145',
      // MiniMaxH3ReferenceToVideo 的四组 Autogrow 输入，各自独立编号，从 0 起
      fieldsByType: {
        image: 'ref_images.ref_image_',
        audio: 'ref_audios.ref_audio_',
        video: 'ref_videos.ref_video_',
        videoAudio: 'ref_video_audios.ref_video_audio_',
      },
      reusePool: { image: ['149'], audio: ['153'], video: ['156'] },
      maxImages: 9,
      maxAudioVideo: 3,
    },
    outputs: ['SaveVideo'],
  },
  {
    id: 'qwen3_tts_voice_design',
    kind: 'tts',
    name: 'Qwen3 TTS 音色设计',
    description: '人物音色设计：给定台词与音色描述，生成设计好的语音样本（Qwen3-TTS VoiceDesign）',
    sourceFile: 'qwen3_tts_voice_design.json',
    roles: {
      text: { node: '74', field: 'value' },
      voice_description: { node: '75', field: 'value' },
      seed: { node: '77', field: 'seed' },
      filename_prefix: { node: '47', field: 'filename_prefix' },
    },
    outputs: ['SaveAudio'],
  },
];

export function getDefaultSpecById(id) {
  return DEFAULT_SPECS.find((s) => s.id === id);
}

// 每种任务（t2i/i2i/r2v/tts）用哪个规格，可在 config.json 的 workflows 里覆盖以切换本机工作流
const KIND_FALLBACK = { t2i: 'krea2_hyperreal_t2i', i2i: 'qwen_image_edit_2511_i2i', r2v: 'minimax_h3_r2v', tts: 'qwen3_tts_voice_design' };

export function getSpecForKind(cfg, kind) {
  const id = cfg?.workflows?.[kind] || KIND_FALLBACK[kind];
  const spec = id ? getDefaultSpecById(id) : null;
  if (!spec) throw new Error('未找到工作流规格：' + kind + ' → ' + id);
  return spec;
}

// —— 技能工厂：确定性工作流解析 ——
// 识别节点类别与语义角色，产出一个「候选规格」。歧义处由上层（LLM 确认）修正。
const LOADER_CLASSES = {
  LoadImage: { mediaType: 'image', field: 'image' },
  LoadAudio: { mediaType: 'audio', field: 'audio' },
  LoadVideo: { mediaType: 'video', field: 'file' },
  UploadImage: { mediaType: 'image', field: 'image' },
};
const SAVE_CLASSES = ['SaveImage', 'SaveVideo', 'SaveAnimatedWEBP', 'VHS_VideoCombine'];
const SAMPLE_CLASSES = ['KSampler', 'SamplerCustomAdvanced', 'KSamplerAdvanced'];
const MODEL_LOADER_RE = /(UNET|CLIP|VAE|Checkpoint|Diffusion|Lora|ControlNet).*Loader|Loader.*(Model|CLIP|VAE|UNET)/i;

function isLoader(classType) { return !!LOADER_CLASSES[classType] || MODEL_LOADER_RE.test(classType); }
function isSave(classType) { return SAVE_CLASSES.includes(classType); }
function isSampler(classType) { return SAMPLE_CLASSES.includes(classType); }

// 判断一个输入值是否为节点引用（ComfyUI 的 ["id", slot]）
function isLink(v) { return Array.isArray(v) && typeof v[0] === 'string'; }

// 文本/提示词候选：字段名 text 或 prompt 且值为字符串
function textRoles(nodes) {
  const pos = []; const neg = [];
  for (const [id, n] of Object.entries(nodes)) {
    const inputs = n.inputs || {};
    for (const [field, val] of Object.entries(inputs)) {
      if (typeof val !== 'string') continue;
      if (field === 'text' || field === 'prompt') {
        const title = (n._meta?.title || n.class_type || '').toLowerCase();
        const isNeg = /neg|negative|负向|负面/.test(title + ' ' + field);
        const sample = val;
        if (isNeg) neg.push({ node: id, field, sample, title: n._meta?.title || n.class_type });
        else pos.push({ node: id, field, sample, title: n._meta?.title || n.class_type });
      }
    }
  }
  return { pos, neg };
}

export function analyzeWorkflow(json, { kindGuess = 'custom', name = '' } = {}) {
  const nodes = json || {};
  const entry = Object.entries(nodes);

  const loaders = { image: [], audio: [], video: [] };
  const modelLoaders = [];
  const saves = [];
  const samplers = [];
  const sizeNodes = [];

  for (const [id, n] of entry) {
    const ct = n.class_type || '';
    if (LOADER_CLASSES[ct]) loaders[LOADER_CLASSES[ct].mediaType].push({ node: id, class: ct, field: LOADER_CLASSES[ct].field });
    else if (MODEL_LOADER_RE.test(ct)) modelLoaders.push({ node: id, class: ct });
    if (isSave(ct)) saves.push({ node: id, class: ct, field: 'filename_prefix' });
    if (isSampler(ct)) samplers.push({ node: id, class: ct });
    // 尺寸：Empty*LatentImage 的 width/height
    const inputs = n.inputs || {};
    if ((ct.startsWith('Empty') && ct.includes('Latent')) || (inputs.width != null && inputs.height != null && ct.includes('Latent'))) {
      sizeNodes.push({ node: id, class: ct });
    }
  }

  const { pos, neg } = textRoles(nodes);

  // 猜语义角色
  const roles = {};
  if (pos.length) roles.positive_prompt = { node: pos[0].node, field: pos[0].field };
  if (neg.length) roles.negative_prompt = { node: neg[0].node, field: neg[0].field };
  if (sizeNodes.length) { roles.width = { node: sizeNodes[0].node, field: 'width' }; roles.height = { node: sizeNodes[0].node, field: 'height' }; }
  // seed：sampler 或 RandomNoise
  for (const [id, n] of entry) {
    const inputs = n.inputs || {};
    if (inputs.seed != null && (isSampler(n.class_type || '') || (n.class_type || '').includes('Noise'))) {
      roles.seed = { node: id, field: 'seed' };
      break;
    }
    if (inputs.noise_seed != null) { roles.seed = { node: id, field: 'noise_seed' }; break; }
  }
  if (saves.length) roles.filename_prefix = { node: saves[0].node, field: 'filename_prefix' };

  // 判断是否视频类（有时长/分辨率/宽高比字段）
  const hasVideoFields = entry.some(([, n]) => {
    const i = n.inputs || {};
    return i.seconds != null || i.resolution != null || i.aspect_ratio != null;
  });
  if (hasVideoFields) {
    for (const [id, n] of entry) {
      const i = n.inputs || {};
      if (i.seconds != null && !roles.seconds) roles.seconds = { node: id, field: 'seconds' };
      if (i.resolution != null && !roles.resolution) roles.resolution = { node: id, field: 'resolution' };
      if (i.aspect_ratio != null && !roles.aspect_ratio) roles.aspect_ratio = { node: id, field: 'aspect_ratio' };
    }
  }

  // 图生图：LoadImage 且非媒体数组 -> image 角色
  if (!roles.image && loaders.image.length) roles.image = { node: loaders.image[0].node, field: loaders.image[0].field };

  const kind = kindGuess === 'custom'
    ? (saves.some((s) => s.class === 'SaveVideo') || hasVideoFields ? 'r2v' : (loaders.image.length ? 'i2i' : 't2i'))
    : kindGuess;

  return {
    kind,
    name: name || '未命名工作流',
    description: '',
    sourceFile: '',
    roles,
    media: null,
    outputs: saves.map((s) => s.class),
    // 供 LLM 确认用的诊断信息
    diagnostics: {
      loaders, modelLoaders, saves, samplers, sizeNodes,
      textCandidates: { pos, neg },
      hasVideoFields,
    },
  };
}

export function listWorkflowFiles() {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  return fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json'));
}
