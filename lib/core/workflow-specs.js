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
