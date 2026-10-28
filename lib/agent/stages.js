// 生成阶段调度：把整条流水线拆成 4 个可独立勾选的阶段（LLM 创作 / 资产图 / 音色 / 分镜视频）。
//
// 设计前提：LLM 与 ComfyUI 由用户手动启停，应用**不根据服务状态决定行为**——不探测对端服务是否
// 在跑、不因为对端在跑就让任务等待或拒绝。同一批里想勾什么就勾什么，全部照跑。
// 任务之间唯一的协调是 job-runner 的视频槽位队列：只在「确实有别的任务在跑」时才串行排队。
//
// 阶段依赖（refs.js）：
//   video 硬依赖 image —— 无参考图时 assembleShotReferences 直接抛错
//   video 软依赖 tts   —— 无 voice_ref 时跳过该角色的参考音，静默降质
import fs from 'node:fs';
import { checkBackend, loadConfig, hardwareMode, Assets, Shots, Chapters, Projects, Jobs, ReferenceImages, logger, resolveProjectPath, llmEndpoint, pausedReason, clearJobPaused, priceForKind } from '../core/index.js';
import { createToolRuntime, runTool, IMAGE_ASSET_CATEGORIES, resolveShotProvisions } from './tools.js';
import { runAgent } from './agent-runtime.js';
import { isAborted, runExclusiveVideo, runJobTask, releaseProject, recordJobLlmUsage, snapshotLlmBilling, prepareLlmBilling, releaseJobLlmHold } from './job-runner.js';
import { attachHoldToJob } from '../core/index.js';

// CK masked-attention 回归：comfy-kitchen 0.2.36（2026-09-29，#207/#208）引入，
// Qwen-Image 2.1 在注意力 mask 存活 token > 64（核 tile 宽度）时崩坏。
// 上游 Comfy-Org/comfy-kitchen#226（open）。详见 plan/CK注意力回归问题调查报告.md。
// 坏版本的**下限**：报告 §6 的版本定位显示 #207/#208 在 0.2.35 之后才落地、随 0.2.36 打包，
// 所以 0.2.35 及更早走的是旧 mask 路径、不受影响。上游至今没有修复版本 →
// 只设下限：≥ 0.2.36 一律按坏处理（未知的新版本宁可拦住，也别默默出一批废图；反过来说，
// 把受影响的旧版本一起拦住是误伤）。上游修好后：提高下限，或改成「下限 + 最后一个坏版本」的区间。
const CK_BAD_MIN = '0.2.36';

// ck: true  = 必须带 --use-ck-attention（实测快 2.7x，见报告 §7.3）
// ck: false = 必须不带（带了 Qwen-Image 出图会崩）
// ck: null  = 两种都行（报告 §7.2：文本编码器走 attention_basic，不受该 bug 影响）
export const STAGES = [
  { id: 'llm', label: 'LLM 创作', need: 'llm', ck: null, desc: '写人物圣经/风格、资产提示词、拆分镜、写视频提示词' },
  { id: 'image', label: '资产图', need: 'comfyui', ck: false, desc: '人物/场景/道具出图（Qwen-Image 2.1）' },
  { id: 'tts', label: '音色', need: 'comfyui', ck: null, desc: 'Qwen3-TTS 设计人物音色样本（供 H3 作参考音）' },
  { id: 'video', label: '分镜视频', need: 'comfyui', ck: true, desc: 'H3 出带语音的镜头视频 + MiniMax Music3 背景音乐 + ffmpeg 合并成片' },
];

export const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.id, s]));

// 版本号分段：必须是纯数字段（0.2.36 / 0.2.36.1）。带后缀的一律算「读不准」
// （0.2.37rc1 / 0.2.36+cu124 之类）：逐段 Number() 会把 rc1 变成 NaN、再被 ||0 当成 0，
// 于是 0.2.37rc1 被读成「0.2.0」而误判为不受影响的旧版本。
function verParts(v) {
  const parts = String(v == null ? '' : v).trim().split('.');
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts;
}

// 版本号比较：a <= b（只比前 3 段，comfy-kitchen 是 0.x.y 形式）
function verLe(a, b) {
  const pa = verParts(a), pb = verParts(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    const d = Number(pa[i] || 0) - Number(pb[i] || 0);
    if (d) return d < 0;
  }
  return true;
}

// 版本号比较：a >= b（相等算命中）
function verGe(a, b) { return verLe(b, a); }

// CK 是否会搞坏 Qwen-Image：开了 CK 且 comfy-kitchen 落在已知坏版本区间内。
// 读不到 / 读不准版本时保守判坏——宁可拦住，也别默默出一批废图。
export function ckBroken(stats) {
  if (!stats || !stats.ckAttention) return false;
  if (!verParts(stats.ckKitchen)) return true;
  return verGe(stats.ckKitchen, CK_BAD_MIN);
}

function gbs(n) { return (n / 1024 ** 3).toFixed(1); }

// 运行前拦截。放行则返回状态供 UI 展示，否则抛错说明为什么不能跑。
export async function preflight(ids, cfg) {
  cfg = cfg || loadConfig();
  const sel = ids.map((i) => STAGE_MAP[i]).filter(Boolean);
  if (!sel.length) throw new Error('未选择任何阶段');

  // CK 缺陷与显存余量判定只对 AMD GGUF 那套工作流有意义，故单独用 amd 判定。
  // 注意这里没有任何「同一批不能同时要 LLM 与 ComfyUI」的拦截：服务由用户手动启停，
  // 用户勾了什么就照跑什么（曾经的 bothLocal 同批/vison 拦截已删除）。
  // 云端 RunningHub 同理：远程 GPU 不与本机 LLM 争卡，也不受本机 CK/显存约束影响。
  const amd = hardwareMode(cfg) === 'amd' && cfg?.comfyui?.provider !== 'runninghub';

  const needsLLM = sel.some((s) => s.need === 'llm');
  const needsComfy = sel.some((s) => s.need === 'comfyui');
  const warns = [];

  // 就绪检查（只快速失败，不排队、不等待）：勾了哪一侧就查哪一侧，缺服务立刻报错退出，
  // 而不是让用户等到 LLM 写完几千字才发现 ComfyUI 根本没启动（白等几十分钟）。
  // 这里不检查「另一侧是否在跑」——那是拿服务状态当开关，服务由用户自己管。
  if (needsLLM) {
    const base = String((cfg.llm && cfg.llm.baseUrl) || '').replace(/\/+$/, '');
    // 探测地址必须按与真实调用相同的规则推导（llmEndpoint 会自动补 /v1）：否则用户把 Base URL
    // 写成 http://127.0.0.1:8080 时，预检打 /models 通过、真正调用打 /v1/chat/completions 却 404，
    // 变成「预检过了、每个阶段都失败」。
    const modelsUrl = llmEndpoint(cfg.llm && cfg.llm.baseUrl).replace(/\/chat\/completions$/, '/models');
    // 需要鉴权的端点（DeepSeek 等云端 OpenAI 兼容 API）不带 Authorization 会回 401，
    // 被下面的 catch 误判成「LLM 未就绪」。本地 llama.cpp 无 apiKey 时不发该头。
    const llmHeaders = {};
    if (cfg.llm && cfg.llm.apiKey) llmHeaders.Authorization = 'Bearer ' + cfg.llm.apiKey;
    try {
      const r = await fetch(modelsUrl, { signal: AbortSignal.timeout(5000), headers: llmHeaders });
      // 401/403 与「服务没起来」不是一回事：多半是云端端点缺 api_key（本地 llama.cpp 不发鉴权头也能过）
      if (r.status === 401 || r.status === 403) throw new Error('HTTP ' + r.status + '（该端点要求鉴权，请在「设置」里填写 LLM api_key）');
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) {
      throw new Error('LLM 未就绪（' + (base || '未配置') + '）：' + e.message + '。请确认 LLM 服务已启动、Base URL 与 api_key 正确。');
    }
  }
  // 纯 LLM 阶段到此为止（不碰 ComfyUI，也不做只对渲染有意义的 CK/显存判定）
  if (!needsComfy) return { ckBroken: false, ckKitchen: '', vramFree: 0, warns };

  const st = await checkBackend(cfg);
  if (!st.ok) throw new Error('ComfyUI 未就绪（' + (cfg?.comfyui?.provider === 'runninghub' ? 'https://www.runninghub.cn' : cfg?.comfyui?.baseUrl) + '）：' + (st.error || '连接失败') + '。请先启动 ComfyUI。');

  // 工作流不是 AMD GGUF 那套：跳过 CK 缺陷与显存余量判定（跑不到 Qwen-Image 2.1，阈值也是按它定的）
  if (!amd) return { ckBroken: false, ckKitchen: st.ckKitchen || '', vramFree: st.vramFree || 0, warns };

  const broken = ckBroken(st);
  const needOff = sel.filter((s) => s.ck === false).map((s) => s.label);

  if (broken && needOff.length) {
    throw new Error(
      '当前 ComfyUI 开启了 --use-ck-attention（comfy-kitchen ' + (st.ckKitchen || '未知') + '），'
      + '在此版本下「' + needOff.join('、') + '」会出损坏图。'
      + '请用 run_amd_gpu_no_ck_attention.bat 重启 ComfyUI 后再跑本阶段。'
    );
  }

  // CK 没坏时 image(ck:false) 与 video(ck:true) 同选无需拦截：坏的只是 Qwen-Image，
  // 同一实例里两个都正确，H3 不开 CK 只是慢 2.7 倍。
  const needOn = sel.filter((s) => s.ck === true);
  const freeGB = st.vramFree / 1024 ** 3;
  const needGB = needOn.length ? 8 : 4;
  if (st.vramFree && freeGB < needGB) {
    throw new Error('显存不足：当前空闲 ' + gbs(st.vramFree) + 'GB，本阶段至少需要约 ' + needGB + 'GB。请先释放显存。');
  }

  if (needOn.length && !st.ckAttention) {
    warns.push('当前 ComfyUI 未开启 --use-ck-attention：H3 出视频约慢 2.7 倍（视频不受 CK 缺陷影响，能正常出片）。');
  }
  if (needOn.length && st.ckAttention) {
    warns.push('本阶段用 CK 加速。comfy-kitchen ' + (st.ckKitchen || '未知') + ' 的 Qwen-Image 缺陷不影响 H3（报告 §7.3 实测 r=0.995）。');
  }

  return { ckBroken: broken, ckKitchen: st.ckKitchen, vramFree: st.vramFree, warns };
}

// 各阶段待办数：由代码算，不问 LLM——这正是原设计让 27B 为一条 SQL 白白启动的缺口。
// image 的类别集合复用 IMAGE_ASSET_CATEGORIES，保证数字与 generate_assets_batch 的实际行为一致。
export function pendingByStage(projectId, chapter) {
  const assets = Assets.list(projectId);
  const shots = Shots.list(projectId).filter((s) => !chapter || s.chapter === chapter);
  const chars = assets.filter((a) => a.category === 'character');

  const imageAssets = assets.filter((a) => IMAGE_ASSET_CATEGORIES.includes(a.category));
  const llmAssetItems = [];
  const llmShotItems = [];
  for (const a of imageAssets) {
    // 已经有成品图（例如上传/图生图/手工替换）的资产，prompt 为空也不欠 LLM 工作；
    // 否则成片都出来了，LLM 阶段还会永久显示「缺提示词」。
    if (!a.prompt && !(a.image_path && a.status === 'done')) llmAssetItems.push('资产「' + a.name + '」缺提示词');
  }
  for (const s of shots) {
    if (!s.video_prompt && !(s.video_path && s.status === 'done')) llmShotItems.push('第' + s.idx + '镜缺视频提示词');
  }
  if (!shots.length) llmShotItems.push('还没有分镜');
  const llmItems = [...llmAssetItems, ...llmShotItems];

  const imageItems = [];
  for (const a of imageAssets) {
    if (a.image_path && a.status === 'done' && (a.prompt_used || '') === (a.prompt || '')) continue;
    imageItems.push('资产「' + a.name + '」' + (a.prompt_used && a.prompt_used !== a.prompt ? '提示词已变更，需重出图' : '未出图') + (a.error ? '（' + String(a.error).slice(0, 120) + '）' : ''));
  }

  const ttsItems = [];
  for (const a of chars) {
    if (!a.voice_ref) { ttsItems.push('角色「' + a.name + '」未设计音色' + (a.error ? '（' + String(a.error).slice(0, 120) + '）' : '')); continue; }
    if ((a.voice_desc_used || '') !== (a.voice_desc || '')) { ttsItems.push('角色「' + a.name + '」声音限制已变更'); continue; }
    try { if (!fs.existsSync(resolveProjectPath(projectId, a.voice_ref))) ttsItems.push('角色「' + a.name + '」音色文件缺失'); }
    catch { ttsItems.push('角色「' + a.name + '」音色文件不可读'); }
  }

  const videoItems = [];
  for (const s of shots) {
    if (s.status === 'done' && (s.video_prompt_used || '') === (s.video_prompt || '')) continue;
    videoItems.push('第' + s.idx + '镜' + (s.video_prompt_used && s.video_prompt_used !== s.video_prompt ? '提示词已变更，需重出视频' : '未出片') + (s.error ? '（' + String(s.error).slice(0, 120) + '）' : ''));
  }

  const pack = (items) => ({ todo: items.length, items: items.slice(0, 20) });
  return {
    llm: { ...pack(llmItems), assetTodo: llmAssetItems.length, shotTodo: llmShotItems.length },
    image: pack(imageItems),
    tts: pack(ttsItems),
    video: pack(videoItems),
  };
}

// 估算一次「按阶段/整章」预计费用：只用于开跑前提示与 requireFullEstimate 闸门，
// 实际扣费仍以每一步预授权为准（提示词、重试、时长变化都会影响实际金额）。
export function estimateProjectCost(projectId, chapter = '', cfg = loadConfig()) {
  const project = Projects.get(projectId);
  if (!project) return { total: 0, currency: cfg?.billing?.currency || '点', items: [] };
  const chapters = Chapters.list(projectId).filter((c) => !chapter || c.title === chapter || c.id === chapter);
  if (!chapters.length) return { total: 0, currency: cfg?.billing?.currency || '点', items: [] };
  const pending = pendingByStage(projectId, chapter || undefined);
  const shots = Shots.list(projectId).filter((s) => !chapter || s.chapter === chapter);
  const pendingShots = shots.filter((s) => s.status !== 'done' || (s.video_prompt_used || '') !== (s.video_prompt || ''));
  const seconds = pendingShots.reduce((n, s) => n + (Number(s.duration) || 0), 0);
  const chapterCount = chapter ? 1 : chapters.length;
  const prices = cfg?.billing?.prices || {};
  const currency = cfg?.billing?.currency || '点';
  const items = [];
  const add = (key, label, quantity, unitPrice) => {
    const qty = Math.max(0, Number(quantity) || 0);
    if (!qty || !(unitPrice > 0)) return;
    items.push({ key, label, quantity: qty, unitPrice, amount: Math.round(qty * unitPrice * 100) / 100, currency });
  };
  if (pending.llm?.todo > 0) add('llm', 'LLM 创作（提示词/分镜）', chapterCount, Number(prices.llmPerChapter) || 0);
  if (pending.image?.todo > 0) add('image', '资产图', pending.image.todo, Number(prices.imagePerAsset) || 0);
  if (pending.tts?.todo > 0) add('tts', '音色', pending.tts.todo, Number(prices.ttsPerVoice) || 0);
  if (seconds > 0) add('video', '分镜视频（按秒）', seconds, Number(prices.videoPerSecond) || 0);
  if (project.enable_bgm !== false && pendingShots.length) add('music', '背景音乐', chapterCount, Number(prices.musicPerTrack) || 0);
  if (cfg?.billing?.chargeExport) add('export', '合成 / 导出', chapterCount, Number(prices.exportPerChapter) || 0);
  const total = Math.round(items.reduce((n, x) => n + x.amount, 0) * 100) / 100;
  return { total, currency, items };
}

// 阶段依赖校验：后面的阶段必须有前置产物，否则执行时必然失败、白烧额度。
// 同一批里包含前置阶段时放行——它们会按数组顺序先跑，再由后者接手。
export function validateStageDependencies(projectId, ids, chapter = '') {
  const sel = new Set(ids || []);
  if (!sel.size) return;
  const assets = Assets.list(projectId);
  const shots = Shots.list(projectId).filter((s) => !chapter || s.chapter === chapter);
  const imageAssets = assets.filter((a) => IMAGE_ASSET_CATEGORIES.includes(a.category));
  const chars = assets.filter((a) => a.category === 'character');
  const pending = pendingByStage(projectId, chapter);

  // LLM 未完成时，后续渲染阶段会拿半成品开工：缺提示词的资产出不了图，缺分镜/视频提示词的视频阶段也会失败。
  // 同一批包含 LLM 时放行，由 startStageJob 在 LLM 跑完后再次硬校验。
  const llmSample = (pending.llm.items || []).slice(0, 3).join('；');
  if ((sel.has('image') || sel.has('tts')) && pending.llm.assetTodo > 0 && !sel.has('llm')) {
    throw new Error('LLM 阶段还有 ' + pending.llm.assetTodo + ' 个资产缺提示词：' + llmSample + '。请先运行「LLM 创作」');
  }
  if (sel.has('video') && pending.llm.shotTodo > 0 && !sel.has('llm')) {
    throw new Error('LLM 阶段还有 ' + pending.llm.shotTodo + ' 个分镜缺视频提示词：' + llmSample + '。请先运行「LLM 创作」');
  }
  if (sel.has('image') && !imageAssets.length) {
    throw new Error('还没有需要出图的资产：请先创建角色 / 场景 / 道具，或运行「LLM 创作」生成资产与提示词');
  }
  if (sel.has('tts') && !chars.length) {
    throw new Error('还没有角色资产，无法设计音色：请先创建角色或运行「LLM 创作」');
  }
  if (sel.has('video')) {
    if (!shots.length && !sel.has('llm')) {
      throw new Error('还没有分镜：请先运行「LLM 创作」生成分镜，再生成视频');
    }
    if (pending.image.todo > 0 && !sel.has('image')) {
      const sample = (pending.image.items || []).slice(0, 3).join('；');
      throw new Error('还有 ' + pending.image.todo + ' 个资产没有出图：' + sample + '。请先运行「资产图」，再生成视频');
    }
    if (pending.tts.todo > 0 && !sel.has('tts')) {
      const sample = (pending.tts.items || []).slice(0, 3).join('；');
      throw new Error('还有 ' + pending.tts.todo + ' 个角色音色未完成：' + sample + '。请先运行「音色」，再生成视频');
    }
    // 视频硬依赖参考图：每个分镜至少要有一个带图片的引用资产，否则渲染必失败
    const byId = new Map(assets.map((a) => [a.id, a]));
    const noRef = shots.filter((s) => {
      const ids = [
        ...(Array.isArray(s.character_ids) ? s.character_ids : []),
        ...(Array.isArray(s.scene_ids) ? s.scene_ids : []),
        ...(Array.isArray(s.prop_ids) ? s.prop_ids : []),
        ...(Array.isArray(s.costume_ids) ? s.costume_ids : []),
        ...(Array.isArray(s.age_ids) ? s.age_ids : []),
      ];
      return !ids.some((aid) => {
        const a = byId.get(aid);
        return !!(a && a.image_path);
      });
    }).length;
    if (noRef && !sel.has('image')) {
      throw new Error('有 ' + noRef + ' 个分镜缺少参考图：请先运行「资产图」或上传素材，再生成视频');
    }
  }
}

// 兜底：把 Agent 联网下载的参考图（origin=downloaded）串到图生图产素材。
// 下载发生在 LLM 阶段（Agent 调 web_search(type=image) + download_reference_image），
// 但 generate_asset_from_reference 是渲染工具、LLM 阶段被硬拦，故只能在 image 阶段这轮确定性循环里补执行。
async function autoGenerateReferenceAssets(ctx) {
  const refs = ReferenceImages.list(ctx.projectId).filter((r) => r.origin === 'downloaded');
  const outs = [];
  for (const ref of refs) {
    try {
      // 已生成过素材并回写了 asset_id → 幂等跳过。
      if (ref.asset_id) continue;
      // 服装/年龄是「挂在角色下的变体」，联网下载的参考图没有所属角色可绑；只对普通素材分类图生图。
      if (!IMAGE_ASSET_CATEGORIES.includes(ref.category)) continue;
      const name = (ref.name || '下载参考素材').trim();
      const out = await runTool(ctx, 'generate_asset_from_reference', {
        reference_id: ref.id,
        category: ref.category,
        name,
        description: ref.description || '',
      });
      const parsed = JSON.parse(out);
      if (parsed && parsed.asset_id) {
        ReferenceImages.update(ref.id, { asset_id: parsed.asset_id });
        outs.push('已用参考图「' + name + '」生成素材');
      }
    } catch (e) {
      // 单张失败不阻断后续镜头，记录原因继续。
      if (ctx.report) ctx.report({ phase: '参考图生成', detail: '参考图「' + (ref.name || '') + '」生成新素材失败：' + ((e && e.message) || e) });
    }
  }
  return outs.length ? '参考图→素材：' + outs.join('；') : '';
}

// 渲染类阶段：直接调工具，全程零 LLM。
// 「还剩什么没做」本来就是一条 status !== 'done' 的 SQL，不该让 27B 来回答。
const RENDER_STAGE_TOOLS = {
  async image(ctx) {
    // 顺序：**先**铺开批量文生图（角色/场景/道具的 canonical 图），**再**做换装/年龄兜底。
    // 兜底是图生图，参考图就是角色的 canonical 图 —— hChangeOutfit / hChangeAge 在它不存在时
    // 直接抛「角色参考图不存在，请先生成/上传角色 canonical 图」，于是新项目首次跑这一阶段时
    // 每个变体都会失败（只落进 notes），要再跑一次资产图阶段才生效。原先排在批量出图之前，
    // 正是这个毛病。
    const titles = ctx.chapter
      ? Chapters.list(ctx.projectId).filter((c) => c.title === ctx.chapter || c.id === ctx.chapter).map((c) => c.title)
      : Chapters.list(ctx.projectId).map((c) => c.title);
    const out = [await runTool(ctx, 'generate_assets_batch', { only: ['image'] })];
    if (ctx.isAborted()) { out.push('已停止（未继续换装/年龄兜底）'); return out.join('\n'); }
    // 换装/年龄兜底必须在有 ComfyUI 的阶段做（LLM 阶段的渲染被硬拦，见 tools.js autoResolveOutfits
    // 的 renderDisabled 分支）。
    const prov = await resolveShotProvisions(ctx, titles);
    if (prov.text) out.push('换装/年龄兜底：' + prov.text);
    if (ctx.isAborted()) { out.push('已停止（未继续参考图素材兜底）'); return out.join('\n'); }
    const refOut = await autoGenerateReferenceAssets(ctx);
    if (refOut) out.push(refOut);
    return out.join('\n');
  },
  tts: (ctx) => runTool(ctx, 'generate_assets_batch', { only: ['tts'] }),
  async video(ctx) {
    // generate_chapter_videos 必须指定章节；未指定则逐章跑完。
    // 每章顺序：生成分镜视频 → 生成背景音乐 → 合并本章成片（垫入 BGM）。
    // 背景音乐与合并都属「增强」步骤：某一章失败不能中断其余章节、更不能让已经跑完的视频作废，
    // 所以逐个 try/catch 把原因记进任务输出继续往下跑；但一章都没合成成功时要明确失败，不静默当成功。
    const titles = ctx.chapter
      ? [ctx.chapter]
      : Chapters.list(ctx.projectId).map((c) => c.title);
    if (!titles.length) throw new Error('项目还没有章节');
    const outs = [];
    let assembled = 0; let lastErr = '';
    for (const t of titles) {
      outs.push(await runTool(ctx, 'generate_chapter_videos', { chapter: t }));
      if (ctx.isAborted()) break;
      try {
        outs.push(await runTool(ctx, 'generate_music', { chapter: t }));
      } catch (e) {
        lastErr = e.message;
        outs.push('章节「' + t + '」背景音乐失败（不影响成片）：' + e.message);
      }
      if (ctx.isAborted()) break;
      try {
        outs.push(await runTool(ctx, 'assemble_video', { chapter: t }));
        assembled++;
      } catch (e) {
        lastErr = e.message;
        outs.push('章节「' + t + '」合并成片失败：' + e.message);
      }
      if (ctx.isAborted()) break;
    }
    if (!assembled && !ctx.isAborted()) throw new Error('没有任何章节合并成片：' + (lastErr || '该章没有已完成的分镜视频'));
    return outs.join('\n');
  },
};

// 串行跑选中阶段。llm 阶段启动 Agent（它自己写完全部文本再收尾），
// 其余阶段直接调工具，不经 LLM。
export function startStageJob({ projectId, stages, chapter, onProgress }) {
  const ids = (stages || []).filter((i) => STAGE_MAP[i]);
  const llmBilling = prepareLlmBilling(projectId, snapshotLlmBilling(projectId, { type: 'stage', chapter, stages: ids }), { chapter });
  const job = Jobs.create({ projectId, type: 'stage', checkpoint: { subject: ids.map((i) => (STAGE_MAP[i] || {}).label || i).join('、'), chapter: chapter || undefined, stages: ids, llmBilling } });
  attachHoldToJob(llmBilling?.holdKey, job.id);
  const emit = (patch) => { if (onProgress) onProgress({ jobId: job.id, projectId, type: job.type, ...patch }); };

  // 只写真正带了值的字段：Jobs.update 内部是 { ...旧, ...新 }，
  // 传 undefined 会把已写好的 phase/detail 抹成空串（run 路由现有写法就有这个坑，别复制）。
  const update = (patch) => {
    const f = {};
    if (patch.phase) f.phase = patch.phase;
    if (patch.detail) f.detail = patch.detail;
    if (Object.keys(f).length) Jobs.update(job.id, f);
    emit(patch);
  };

  const ctx = createToolRuntime({
    projectId, jobId: job.id, chapter,
    // 渲染阶段：禁止调用 LLM（与 llmCtx 的 renderDisabled 对称，双向分离）
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: update,
  });
  // const llmCtx = createToolRuntime({
  //   projectId, jobId: job.id, chapter,
  //   isAborted: isAborted(job.id),
  //   onProgress: update,
  //   renderDisabled: true,
  // });

  const run = async () => {
    const results = {};
    for (const id of ids) {
      // 停止后不再启动后续阶段：之前这里不查 isAborted，用户点了「停止」，
      // 已跑完的阶段会继续触发后面的阶段，任务看似停了其实还在烧。
      if (ctx.isAborted()) { results.aborted = true; break; }
      const st = STAGE_MAP[id];
      update({ phase: st.label, detail: st.desc });
      if (id === 'llm') {
        results.llm = String(await runAgent({
          projectId, chapter, jobId: job.id,
          onProgress: update,
          isAborted: isAborted(job.id),
          renderDisabled: true,
        }) || '').slice(0, 2000);
        // LLM 阶段结束不等于所有提示词都齐了：Agent 可能只处理了一部分。
        // 如果同一批还要跑后续渲染阶段，缺提示词/缺分镜时必须停下，不能让半成品继续出图/出片。
        const afterLlm = pendingByStage(projectId, chapter);
        if (afterLlm.llm.todo > 0) {
          results.llmPending = afterLlm.llm;
          const laterAsset = ids.some((x) => x === 'image' || x === 'tts');
          const laterVideo = ids.includes('video');
          const blocking = (laterAsset && afterLlm.llm.assetTodo > 0) || (laterVideo && afterLlm.llm.shotTodo > 0);
          const sample = (afterLlm.llm.items || []).slice(0, 3).join('；');
          const detail = '完成，但仍有 ' + afterLlm.llm.todo + ' 项待办：' + sample + (afterLlm.llm.todo > 3 ? ' 等' : '');
          if (blocking) {
            update({ phase: st.label, detail });
            throw Object.assign(new Error(detail + '。已停止后续阶段，请先处理这些项目。'), { code: 'STAGE_INCOMPLETE', stage: 'llm', pending: afterLlm.llm });
          }
          update({ phase: st.label, detail });
        }
      } else {
        results[id] = await RENDER_STAGE_TOOLS[id](ctx);
        const after = pendingByStage(projectId, chapter);
        const p = after[id];
        if (p && p.todo > 0) {
          results[id + 'Pending'] = p;
          const sample = (p.items || []).slice(0, 3).join('；');
          const detail = '完成，但仍有 ' + p.todo + ' 项待办：' + sample + (p.todo > 3 ? ' 等' : '');
          if (id === 'image' && ids.includes('video')) {
            update({ phase: st.label, detail });
            throw Object.assign(new Error('资产图阶段' + detail + '。已停止视频阶段，请先处理这些资产。'), { code: 'STAGE_INCOMPLETE', stage: 'image', pending: p });
          }
          if (id === 'tts' && ids.includes('video')) {
            update({ phase: st.label, detail });
            throw Object.assign(new Error('音色阶段' + detail + '。已停止视频阶段，请先处理这些音色。'), { code: 'STAGE_INCOMPLETE', stage: 'tts', pending: p });
          }
          update({ phase: st.label, detail });
        }
      }
      if (!results[id + 'Pending']) update({ phase: st.label, detail: '完成' });
    }
    return results;
  };

  // 本地：整批走视频闸门（避免与手动重生成并发抢显存）；
  // 云端 RunningHub：不占整批槽位，渲染步骤各自进公平队列（见 workflow-runner）。
  const onQueue = (st) => {
    const phase = st === 'queued' ? '排队中' : '准备';
    Jobs.update(job.id, { status: st, phase });
    emit({ phase, status: st });
  };
  runJobTask(run, isAborted(job.id), { jobId: job.id, onQueue })
    .then((r) => {
      // 只跑了一部分阶段，不能像 startCreateJob 那样置 'done'，置回 'idle' 才不会骗前端；
      // 队列还有别的任务时保持运行态（见 releaseProject）。
      releaseProject(projectId, job.id);
      // 运行中被停止时 run() 会正常 resolve（各阶段自己提前 return/break），
      // 这里必须和 catch 分支同口径记 cancelled：否则用户点了「停止」，前端收到 status:'done'
      // 反而弹「✅ 任务完成」——明明后面几章都没出。
      // 判据用 isAborted 而不是 run() 返回的 results.aborted：后者只在「下一个阶段开始前」才置位，
      // 停在最后一个阶段时它根本不会被设置。
      const paused = pausedReason(job.id);
      const cancelled = !paused && isAborted(job.id)();
      Jobs.update(job.id, {
        status: paused ? 'failed' : (cancelled ? 'cancelled' : 'done'),
        phase: paused ? '积分不足' : (cancelled ? '已取消' : '完成'),
        detail: JSON.stringify(r),
        error: paused || (cancelled ? '已取消' : ''),
        finishedAt: Date.now(),
      });
      emit({ phase: paused ? '积分不足' : (cancelled ? '已取消' : '完成'), detail: JSON.stringify(r), status: paused ? 'failed' : (cancelled ? 'cancelled' : 'done'), paused: !!paused });
      if (!cancelled && !paused) recordJobLlmUsage(job, projectId);
      else releaseJobLlmHold(job, paused ? '积分不足暂停' : '任务已取消');
      if (paused) clearJobPaused(job.id);
    })
    .catch((e) => {
      // 与 job-runner.finishJobError 同一约定：用户主动停止记 cancelled 而不是 failed，
      // 否则「停止」会在任务列表里显示成失败（releaseProject 已把项目置回 idle）。
      const paused = pausedReason(job.id);
      const cancelled = !paused && isAborted(job.id)();
      releaseJobLlmHold(job, paused ? '积分不足暂停' : (cancelled ? '任务已取消' : '任务失败'));
      releaseProject(projectId, job.id);
      Jobs.update(job.id, {
        status: paused ? 'failed' : (cancelled ? 'cancelled' : 'failed'),
        phase: paused ? '积分不足' : (cancelled ? '已取消' : '失败'),
        error: paused || (cancelled ? '已取消' : e.message),
        finishedAt: Date.now(),
      });
      emit({ phase: paused ? '积分不足' : (cancelled ? '已取消' : '失败'), detail: paused || (cancelled ? '已取消' : e.message), status: paused ? 'failed' : (cancelled ? 'cancelled' : 'failed'), paused: !!paused });
      if (paused) clearJobPaused(job.id);
      if (!cancelled && !paused) logger.error('stage: 阶段任务失败', { projectId, stages: ids, error: e.message });
    });

  return job;
}

