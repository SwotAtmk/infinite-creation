// 内容安全规则（可独立维护）。
// 这里只放「明确违规、不依赖语境」的硬拦截词；政治/军事/宗教的语境判断交给 LLM 审核，
// 避免把正常的虚构战争、门派、历史设定一刀切掉。
//
// 维护方式：直接增删数组项；支持环境变量 IC_MODERATION_EXTRA 追加自定义词（逗号分隔）。
export const CATEGORY_LABELS = {
  sexual: '色情/裸露',
  violence: '暴力/血腥',
  political: '政治敏感',
  military: '军事/武器',
  religious: '宗教',
  other: '其他',
};

export const HARD_BLOCK = {
  sexual: [
    '色情', '情色', '成人视频', 'A片', '黄片', '淫秽', '淫荡', '裸体', '全裸', '裸露', '露点',
    '性交', '性爱', '做爱', '口交', '肛交', '自慰', '射精', '阴道', '阴茎', '乳头',
    '强奸', '轮奸', '迷奸', '乱伦', '兽交', '恋童', '儿童色情', '未成年性', '幼女', '萝莉控',
    'porn', 'nude', 'naked', 'hentai', 'blowjob', 'anal sex', 'cum', 'orgasm',
    'masturbation', 'rape', 'incest', 'pedophile', 'child porn', 'explicit sex',
  ],
  violence: [
    '血腥', '肢解', '分尸', '开膛', '剖腹', '挖眼', '割喉', '斩首', '爆头', '脑浆', '内脏外露',
    '虐杀', '大屠杀', '灭门', '自杀方法', '割腕', '上吊', '恐怖袭击', '炸弹制作', '自制炸弹', '制炸',
    'gore', 'dismember', 'decapitat', 'torture', 'massacre', 'suicide method', 'self-harm',
    'terrorist attack', 'bomb making',
  ],
  political: [
    '台独', '港独', '藏独', '疆独', '法轮功', '六四事件', '颠覆国家政权', '反政府武装',
    '政治暗杀', '分裂国家', '煽动颠覆', '推翻政府', '军事政变', '游行示威', '抗议政府',
    '反华', '辱华', '暗杀国家领导人',
  ],
  military: [
    '武器制造', '枪械制造', '弹药制作', '炸药配方', '炸弹配方', '自制炸药', '生化武器',
    '化学武器', '核武器制造', '导弹发射', '战争罪', '屠杀平民', '雇佣兵', '恐怖组织',
    '军火走私', 'weapon manufacturing', 'explosive recipe', 'bio weapon', 'chemical weapon',
    'nuclear weapon', 'war crime', 'mercenary', 'terrorist organization',
  ],
  religious: [
    '邪教', '圣战', '宗教战争', '异教徒', '亵渎神明', '亵渎宗教', '传教', '洗脑信仰',
    '宗教极端', '宗教仇恨', 'cult', 'jihad', 'crusade', 'blasphemy', 'religious hate',
    'religious propaganda',
  ],
};

export const EXTRA_BLOCK = String(process.env.IC_MODERATION_EXTRA || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

// 零容忍：儿童性内容。这一小撮**不做语境判断**，任何虚构/历史/艺术设定都不放行。
// 其余 HARD_BLOCK 词只作为「提示」，最终由 LLM 按整段语义判断（见 moderation.js）。
export const NEVER_ALLOW = {
  sexual: ['儿童色情', '未成年性', '幼女', '恋童', 'child porn', 'pedophile', 'csam'],
};

export const FIELD_LABELS = {
  name: '名称',
  title: '标题',
  novel: '小说原文',
  script: '剧本',
  idea: '创意',
  style: '风格',
  description: '描述',
  prompt: '提示词',
  negative_prompt: '反向提示词',
  visual: '画面',
  dialogue: '台词',
  narration: '旁白',
  sub_shots: '子镜头',
  video_prompt: '视频提示词',
  caption: '音乐描述',
  lyrics: '歌词',
  voice_desc: '音色描述',
  feedback: '反馈',
  scene_name: '场景名',
  camera: '镜头',
};
