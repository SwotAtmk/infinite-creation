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
import { checkBackend, loadConfig, hardwareMode, Assets, Shots, Chapters, Projects, Jobs, logger, resolveProjectPath } from '../core/index.js';
import { createToolRuntime, runTool, IMAGE_ASSET_CATEGORIES } from './tools.js';
import { runOpenClaudeAgent } from './openclaude-agent.js';
import { isAborted, runExclusiveVideo, releaseProject } from './job-runner.js';

// CK masked-attention 回归：comfy-kitchen 0.2.36（2026-09-29，#207/#208）引入，
// Qwen-Image 2.1 在注意力 mask 存活 token > 64（核 tile 宽度）时崩坏。
// 上游 Comfy-Org/comfy-kitchen#226（open）。详见 plan/CK注意力回归问题调查报告.md。
const CK_BAD_MAX = '0.2.36';

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

// 版本号比较：a <= b
function verLe(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0;
  }
  return true;
}

// CK 是否会搞坏 Qwen-Image：开了 CK 且 comfy-kitchen 落在已知坏版本区间内。
// 读不到版本时保守判坏——宁可拦住，也别默默出一批废图。
export function ckBroken(stats) {
  if (!stats || !stats.ckAttention) return false;
  if (!stats.ckKitchen) return true;
  return verLe(stats.ckKitchen, CK_BAD_MAX);
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
    // 需要鉴权的端点（DeepSeek 等云端 OpenAI 兼容 API）不带 Authorization 会回 401，
    // 被下面的 catch 误判成「LLM 未就绪」。本地 llama.cpp 无 apiKey 时不发该头。
    const llmHeaders = {};
    if (cfg.llm && cfg.llm.apiKey) llmHeaders.Authorization = 'Bearer ' + cfg.llm.apiKey;
    try {
      const r = await fetch(base + '/models', { signal: AbortSignal.timeout(5000), headers: llmHeaders });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) {
      throw new Error('LLM 未就绪（' + (base || '未配置') + '）：' + e.message + '。请先启动 LLM 服务并加载模型。');
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

  // llm：缺提示词的资产 + 缺视频提示词的分镜；分镜一个都没有也算 1（还得先拆镜）
  const textTodo =
    assets.filter((a) => IMAGE_ASSET_CATEGORIES.includes(a.category) && !a.prompt).length
    + shots.filter((s) => !s.video_prompt).length
    + (shots.length ? 0 : 1);

  return {
    llm: { todo: textTodo },
    // image：与 hGenerateAssetsBatch 的跳过条件逐字一致（已生成且提示词未变过才跳过）
    image: { todo: assets.filter((a) => IMAGE_ASSET_CATEGORIES.includes(a.category) && !(a.image_path && a.status === 'done' && (a.prompt_used || '') === (a.prompt || ''))).length },
    // tts：与 hGenerateAssetsBatch 的跳过条件逐字一致（voice_ref 非空 *且* 文件真实存在）。
    // 只看字段会漏报——voice_ref 有值但文件被删时，批量工具仍会重跑，数字却显示 0。
    tts: { todo: chars.filter((a) => {
      if (!a.voice_ref) return true;
      if ((a.voice_desc_used || '') !== (a.voice_desc || '')) return true; // 声音限制改过 → 需重做
      try { return !fs.existsSync(resolveProjectPath(projectId, a.voice_ref)); }
      catch { return true; }
    }).length },
    // video：与 hGenerateChapterVideos 的筛选条件一致（提示词改过也要算待办）
    video: { todo: shots.filter((s) => s.status !== 'done' || (s.video_prompt_used || '') !== (s.video_prompt || '')).length },
  };
}

// 渲染类阶段：直接调工具，全程零 LLM。
// 「还剩什么没做」本来就是一条 status !== 'done' 的 SQL，不该让 27B 来回答。
const RENDER_STAGE_TOOLS = {
  image: (ctx) => runTool(ctx, 'generate_assets_batch', { only: ['image'] }),
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
  const job = Jobs.create({ projectId, type: 'stage', checkpoint: { subject: ids.map((i) => (STAGE_MAP[i] || {}).label || i).join('、') } });
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
        results.llm = String(await runOpenClaudeAgent({
          projectId, chapter, jobId: job.id,
          onProgress: update,
          isAborted: isAborted(job.id),
          renderDisabled: true,
        }) || '').slice(0, 2000);
      } else {
        results[id] = await RENDER_STAGE_TOOLS[id](ctx);
      }
      update({ phase: st.label, detail: '完成' });
    }
    return results;
  };

  // 整批走视频闸门：既与手动「重新生成」串行（否则并发提交必撞超时），
  // 也顺带防止 LLM 阶段与并发的视频渲染同时抢显存。判据只有「前面是否有任务在跑」，不探测服务。
  const onQueue = (st) => {
    const phase = st === 'queued' ? '排队中' : '准备';
    Jobs.update(job.id, { status: st, phase });
    emit({ phase, status: st });
  };
  runExclusiveVideo(run, isAborted(job.id), { jobId: job.id, onQueue })
    .then((r) => {
      // 只跑了一部分阶段，不能像 startCreateJob 那样置 'done'，置回 'idle' 才不会骗前端；
      // 队列还有别的任务时保持运行态（见 releaseProject）。
      releaseProject(projectId, job.id);
      Jobs.update(job.id, { status: 'done', phase: '完成', detail: JSON.stringify(r), error: '', finishedAt: Date.now() });
      emit({ phase: '完成', detail: JSON.stringify(r), status: 'done' });
    })
    .catch((e) => {
      // 与 job-runner.finishJobError 同一约定：用户主动停止记 cancelled 而不是 failed，
      // 否则「停止」会在任务列表里显示成失败（releaseProject 已把项目置回 idle）。
      const cancelled = isAborted(job.id)();
      releaseProject(projectId, job.id);
      Jobs.update(job.id, { status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? '已取消' : '失败', error: cancelled ? '已取消' : e.message, finishedAt: Date.now() });
      emit({ phase: cancelled ? '已取消' : '失败', detail: cancelled ? '已取消' : e.message, status: cancelled ? 'cancelled' : 'failed' });
      if (!cancelled) logger.error('stage: 阶段任务失败', { projectId, stages: ids, error: e.message });
    });

  return job;
}

