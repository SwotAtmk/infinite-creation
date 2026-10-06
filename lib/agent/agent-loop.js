import { llmChat, extractJson, logger, Messages, Chapters } from '../core/index.js';
import { TOOL_DEFINITIONS, runTool } from './tools.js';
import { loadSkill, listSkills } from './skill-engine.js';

const MAX_STEPS = 1500;

export function buildSystemPrompt({ ctx, skillName }) {
  const skill = loadSkill(skillName || 'novel-to-video');
  const parts = [];
  parts.push('你是「无限创作」的自主创作 Agent，负责把小说/故事全自动改编为带语音的视频成片。你拥有调用本地 ComfyUI（MiniMax H3 视频 + Qwen-Image/Krea2 文生图/图生图 + Qwen3-TTS 音色）与 ffmpeg 的能力。');
  parts.push('铁律：全程自主决策，不要向用户询问中间确认；遇到失败先重试、再降级、最后记录并继续；操作必须幂等（已完成资产/分镜跳过），以便断点续跑。');
  if (skill) {
    parts.push('【当前工作模式技能：' + skill.name + '】\n' + skill.body);
  }
  const catalog = listSkills();
  if (catalog.length) {
    const lines = catalog.map((s) => '- ' + s.name + '：' + (s.description || ''));
    parts.push('可用技能目录（仅摘要，禁止凭摘要臆测其规范；命中对应任务前必须先调用 skill(名字) 加载全文再遵循）：\n' + lines.join('\n'));
    parts.push('技能→任务映射：写视频提示词→skill(h3-prompt-writing)；拆分镜脚本→skill(story-pipeline-cn)；写图片/图生图提示词→skill(image-prompt-writing)；设计人物音色→skill(tts-voice-design)；总流水线→skill(novel-to-video)。');
    parts.push('短剧/漫剧技能映射（项目为短剧/漫剧/剧本改编时命中，先 skill(名字) 加载全文再遵循，其 references 用 skill_reference(name, ref) 按需加载）：短剧逐集编剧/大纲扩写→skill(0715-scriptwriter)；剧本创作总控/交付→skill(script-master)；小说改编剧本→skill(novel-to-skitscreenplay)；剧本/小说转分镜→skill(novel-to-storyboard)；文字分镜JSON→skill(hf-drama-storyboard-script)；漫剧前期策划→skill(ai-manga-planner)；漫剧导演→skill(manju-director-agent)；漫剧全流程→skill(manga-drama-generator)；脚本转漫剧→skill(script-to-manga)；漫剧分镜解析/3D漫剧→skill(comic-drama-generator)；影视级分镜+镜头库→skill(cinematic-ai-comic-director)；道具/年代一致性→skill(era-consistency-optimizer)；全栈分镜提示词→skill(manga-full-stack)。');
  }
  const c = ctx.project.context || {};
  if (c.bible) parts.push('【人物圣经（一致性锚点，后续所有生成必须遵守）】\n' + c.bible);
  if (c.style) parts.push('【风格指南（统一画风/光线/色调）】\n' + c.style);
  if (c.continuity) parts.push('【连续性记录】\n' + c.continuity);
  parts.push('【人物着装（多套服装/衣橱）铁律】人物外貌/发型/配色必须与人物圣经一致，但每个角色要有多套服装：角色设计阶段根据剧情为该角色规划「衣橱」（如日常服/外出服/沐浴后家居服/正式礼服等，每套给短名+外观描述），先用 generate_assets_batch 生成角色 canonical 图，再用 design_outfits(character_id, outfits) 一次性生成全部服装资产（category=costume，parent_id 指向角色）。写分镜时按剧情为每镜在 set_storyboard 的 costumes 字段引用该镜对应那套服装；剧情出现沐浴/洗澡/更衣/换衣/换装等换装事件时，换装事件之后的镜头改用新一套服装、之前的镜头用旧一套。系统会在 set_storyboard 时自动识别换装事件兜底，但你应主动设计衣橱并逐镜写清 costumes，避免穿帮。');
  parts.push('项目参数：风格=' + (ctx.project.style || '未指定') + '，视频分辨率=' + (ctx.project.video_resolution || '480P') + '，宽高比=' + (ctx.project.video_aspect_ratio || '16:9'));
  parts.push('当前 LLM 支持图片输入：' + (ctx.cfg.llm?.vision ? '是' : '否') + (ctx.cfg.llm?.vision ? '。写视频提示词前，先用 list_assets 拿到全部资产，再用 view_asset 一次性查看每个唯一角色/场景/道具的参考图（每个资产只看一次并记住、后续所有镜头复用，禁止对同一张图反复查看）；仅当某镜头引用了尚未查看过的资产时才用 view_shot_references(shot_id) 补看。只给 list_shots 中 has_prompt=false 的镜头写视频提示词（has_prompt=true 的跳过，用于断点续跑）。基于真实参考图写提示词，避免逐镜重复查看造成上下文膨胀。' : '。不要尝试查看图片，仅用文本描述写提示词。'));
  parts.push('本次生成目标：' + (ctx.chapter ? ('章节「' + ctx.chapter + '」（只生成该章，其它章节不要动）') : '全部章节'));
  parts.push('若目标章节正文（novel）为空，则以项目「想法 idea」作为故事前提自行展开完整剧情；不要因为正文为空而拒绝生成。');

  // 只跑 LLM 的阶段（渲染另起一批）：到此为止，不灌「成片导出」那段。
  // 否则 Agent 会为了达成「全部视频 done + 合并导出」而反复调用被 runTool 拦掉的渲染工具。
  if (ctx.renderDisabled) {
    parts.push('【本阶段只做文本创作，禁止一切渲染】本批没有启动 ComfyUI：LLM 与 ComfyUI 同时常驻会爆显存，所以渲染必须另起一批。');
    parts.push('本阶段职责：读入大纲/正文 → 写人物圣经与风格 → 为每个资产写图片提示词与音色描述（update_asset 的 prompt / voice_description）→ 拆分镜（set_storyboard，先 skill(story-pipeline-cn)）→ 为每镜写视频提示词（video_prompt，先 skill(h3-prompt-writing)）。');
    parts.push('以下工具已被禁用，调用只会返回「已跳过」，重试无意义，请不要调用：generate_asset_image、edit_asset_image、change_outfit、design_outfits、generate_assets_batch、design_voice、generate_shot_video、regenerate_shot、generate_chapter_videos、assemble_video。');
    parts.push('把所有文本写到数据库后就汇报「文本阶段完成」并结束本轮。不要等待渲染结果，也不要反复尝试被禁用的工具。待办会自动保留，由后续渲染阶段接手。');
    return parts.join('\n\n');
  }

  parts.push('硬性完成要求：分镜必须完整覆盖该章（按 story-pipeline-cn 模式C 长镜头聚合：同一场景连续动作+多句连贯对白合并成一镜，仅场景切换/时空断开才换镜，同一分镜最多 2 个说话人（≥3 人对话拆成多个分镜），禁止一句一镜/碎片化，也禁止压缩/省略/偷工）。**镜头时长必须贴合内容节奏，禁止为凑时长拖长**：时长 ≈ 台词字数÷4.5 + 动作/情绪缓冲 1–3 秒，取整后夹在 2–15 秒之间；一句短台词（约 8–15 字）只给 2–4 秒，绝不为凑 10 秒把短镜头拖长（拖长会产生呆板空镜、打乱节奏）；只有真正的连续动作+多句对白才给长镜头（最长 15 秒）。每镜台词字数 ≤ 时长秒×5（中文旁白约 4-5 字/秒），超长台词必须拆镜或压缩台词，否则会被 H3/TTS 压缩成听不清的模糊声。**相邻镜头要衔接自然**：同场景连续镜头写视频提示词时保持人物位置/朝向/动作方向/光线色调连续，并写清本镜起幅与上一镜落幅的衔接关系（动作接续/视线匹配/运动方向连续），避免跳跃感。视频用 generate_chapter_videos(该章) 一次生成全部镜头，直到该章所有镜头 done（remaining=0）。**不因时间长短、镜头多少、失败次数而提前停止**——必须把该章全部分镜视频都生成完才进入导出。');
  parts.push('用工具完成整条流水线：读入大纲 → 写人物圣经/风格 → 写资产生图/音色提示词并生成 → 写分镜（先 skill(story-pipeline-cn)）→ 写视频提示词（先 skill(h3-prompt-writing)）→ generate_chapter_videos 生成该章全部视频 → 合并导出。每一步用 report 汇报进度。');
  return parts.join('\n\n');
}
export async function runAgentLoop({ ctx, skillName, onMessage }) {
  const messages = [{ role: 'system', content: buildSystemPrompt({ ctx, skillName }) }];
  let chapters = Chapters.list(ctx.projectId).map((c) => ({ id: c.id, title: c.title, novel: c.novel }));
  const target = ctx.chapter || '';
  if (target) chapters = chapters.filter((c) => c.title === target || c.id === target);
  const seed = JSON.stringify({ project: { name: ctx.project.name, style: ctx.project.style, idea: ctx.project.idea || '' }, targetChapter: target || null, chapters, novel: chapters.map((c) => c.novel).join('\n\n').slice(0, 6000) });
  messages.push({ role: 'user', content: '开始执行：请把下面的项目完成到成片导出。\n' + seed });

  let useNativeTools = !!(ctx.cfg.llm.tools !== false);
  let lastContent = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    if (ctx.isAborted && ctx.isAborted()) throw new Error('任务已停止');
    let resp;
    try {
      resp = await llmChat(ctx.cfg.llm, messages, {
        temperature: 0.7,
        maxTokens: 8000,
        tools: useNativeTools ? TOOL_DEFINITIONS : null,
      });
    } catch (e) {
      logger.warn('agent: LLM 调用失败，降级 JSON 动作模式', { error: e.message });
      useNativeTools = false;
      // 重试一次不带 tools
      try {
        resp = await llmChat(ctx.cfg.llm, messages, { temperature: 0.7, maxTokens: 8000 });
      } catch (e2) {
        throw new Error('LLM 调用失败：' + e2.message);
      }
    }

    lastContent = resp.content || '';

    // 原生工具调用
    if (useNativeTools && resp.toolCalls && resp.toolCalls.length) {
      const results = [];
      for (const tc of resp.toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        try {
          const r = await runTool(ctx, tc.function?.name, args);
          results.push(r);
          if (onMessage) onMessage({ role: 'tool', name: tc.function?.name, args, result: String(r).slice(0, 500) });
        } catch (e) {
          results.push('ERROR: ' + e.message);
          if (onMessage) onMessage({ role: 'tool', name: tc.function?.name, args, error: e.message });
        }
      }
      messages.push(...toolResultMessage(resp, results));
      continue;
    }

    // JSON 动作块（回退模式）
    const action = parseAction(lastContent);
    if (action?.tool) {
      let result;
      try {
        result = await runTool(ctx, action.tool, action.args || {});
      } catch (e) { result = 'ERROR: ' + e.message; }
      messages.push({ role: 'assistant', content: lastContent });
      messages.push({ role: 'user', content: '工具 ' + action.tool + ' 返回：\n' + result });
      if (onMessage) onMessage({ role: 'tool', name: action.tool, args: action.args, result: String(result).slice(0, 500) });
      continue;
    }
    if (action?.final !== undefined) {
      return action.final;
    }

    // 无工具调用的纯文本：若已接近完成则结束
    const doneHint = /完成|成片|导出|finish|done|总结/i.test(lastContent);
    if (doneHint && !useNativeTools) return lastContent;
    // 否则让它继续（追加提示）
    messages.push({ role: 'assistant', content: lastContent });
    messages.push({ role: 'user', content: '请继续：使用工具推进流水线；若已全部完成，输出 {"final":"...总结..."}。' });
  }
  return lastContent || '（达到最大步数）';
}
