// 共享常量与类型约定（纯数据，无运行时依赖）

// 资产分类（用户要求：人物/场景/道具/语音等统一整理）
export const ASSET_CATEGORIES = [
  { id: 'character', label: '人物', labelEn: 'Character' },
  { id: 'scene', label: '场景', labelEn: 'Scene' },
  { id: 'prop', label: '道具', labelEn: 'Prop' },
  { id: 'costume', label: '服装', labelEn: 'Costume' },
  { id: 'voice', label: '语音', labelEn: 'Voice' },
  { id: 'music', label: '音乐', labelEn: 'Music' },
  { id: 'sfx', label: '音效', labelEn: 'SFX' },
  { id: 'video', label: '视频', labelEn: 'Video' },
  { id: 'other', label: '其他', labelEn: 'Other' },
];
export const ASSET_CATEGORY_IDS = ASSET_CATEGORIES.map((c) => c.id);
export const ASSET_CATEGORY_LABEL = Object.fromEntries(ASSET_CATEGORIES.map((c) => [c.id, c.label]));

// 分镜状态
export const SHOT_STATUS = {
  pending: '待生成',
  generating: '生成中',
  done: '完成',
  failed: '失败',
};

// 后台任务状态
export const JOB_STATUS = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  interrupted: '已中断',
};

export const JOB_TYPES = ['create', 'regenerate', 'import_workflow'];

export const SKILL_SOURCES = ['bundled', 'installed', 'generated'];

export const WORKFLOW_KINDS = ['t2i', 'i2i', 'r2v', 'custom'];

// 项目目录下的分类子目录名（相对 data/projects/<id>/assets/<category>）
export const PROJECT_ASSET_SUBDIRS = {
  character: 'characters',
  scene: 'scenes',
  prop: 'props',
  costume: 'costumes',
  voice: 'voice',
  music: 'music',
  sfx: 'sfx',
  video: 'videos',
  other: 'other',
};

// 文生图宽高比 -> [宽, 高]（32 的倍数，兼容 Qwen-Image）
export const RATIO_SIZES = {
  '1:1': [1024, 1024],
  '16:9': [1344, 768],
  '9:16': [768, 1344],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '3:2': [1152, 768],
  '2:3': [768, 1152],
  '21:9': [1344, 576],
};
export const RATIO_LIST = Object.keys(RATIO_SIZES);
export function ratioToSize(ratio) {
  return RATIO_SIZES[ratio] || RATIO_SIZES['16:9'];
}

// 工作流规格（WorkflowRunner 的驱动描述，技能工厂也产出同结构）
// roles: 语义角色 -> { node, field }
// media: 参考素材（视频类工作流）如何绑定；无则省略
// outputs: 输出节点 class_type 列表，用于在 history 中收集结果
export const WORKFLOW_SPEC_SCHEMA = {
  id: 'string, 唯一 id',
  kind: 't2i|i2i|r2v|custom',
  name: '显示名',
  description: '用途说明',
  sourceFile: 'workflows/ 下的模板文件名',
  roles: {
    positive_prompt: '{ node, field }',
    negative_prompt: '{ node, field }',
    width: '{ node, field }',
    height: '{ node, field }',
    seed: '{ node, field }',
    seconds: '{ node, field }',          // 视频时长
    resolution: '{ node, field }',        // 视频分辨率
    aspect_ratio: '{ node, field }',      // 视频宽高比
    image: '{ node, field }',             // 图生图参考图
    filename_prefix: '{ node, field }',   // 输出前缀
  },
  media: {
    targetNode: '承载 media_N 的节点 id',
    mediaField: "字段名前缀，默认 'media_'",
    typeField: "字段名前缀，默认 'media_type_'",
    loaders: '{ image: {class,field}, audio: {...}, video: {...} }',
    reusePool: '{ image: [已有节点id...], audio: [...], video: [...] }',
    maxImages: '图片上限',
    maxAudioVideo: '音视频上限',
  },
  outputs: ['SaveImage', 'SaveVideo'],
};
