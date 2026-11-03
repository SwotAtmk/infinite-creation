// 背景音乐「写词/编曲」预处理器。
// 调用 skills/music-caption-rewriter 技能，把用户的一句话 caption + 歌词重写成
// MiniMax Music 3 可直接使用的结构化 caption（Global Metadata / Vocal Details / Arrangement），
// 并把歌词整理成带段落标签（[Intro]/[Verse]/[Chorus]…）的可编曲版本。
//
// 这里是「一次性改写」：先按技能的 Genre Router 选风格族，再只读该族的紧凑卡片表；
// 不整库扫描模板，也不执行任何脚本（与技能自身的纪律一致）。
// 技能文件缺失或 LLM 失败时抛错，由调用方退回原始输入，不阻断音乐生成。
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR } from './config.js';
import { llmChat, extractJson } from './llm.js';

const SKILL_NAME = 'music-caption-rewriter';
// 与 references/genre-router.md 的 Family map 一一对应（route → references/index-<route>.md）
const FAMILIES = new Set([
  'east-asian-modern', 'east-asian-ballad-heritage', 'modern-rnb-neo-soul', 'soul-blues-gospel',
  'cinematic-pop-ballad', 'cinematic-orchestral-epic', 'electronic-synth-ambient-pop', 'jazz-swing-big-band',
  'traditional-vocal-stage', 'hip-hop-rap', 'metal-heavy-rock', 'pop-alternative-rock',
  'contemporary-folk-acoustic', 'roots-traditional-global', 'general-pop-ballad', 'dance-pop-disco-funk',
  'club-edm-house-trance', 'country-americana',
]);
// 风格族的紧凑卡片表可能上万字：截断到可控长度，避免本地小上下文模型直接被撑爆。
const INDEX_CHAR_LIMIT = 14000;

function readSkillFile(rel) {
  try {
    return fs.readFileSync(path.join(SKILLS_DIR, SKILL_NAME, rel), 'utf8');
  } catch {
    return '';
  }
}

function stripFrontmatter(text) {
  const m = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(text || '');
  return m ? String(text).slice(m[0].length) : String(text || '');
}

function familyCards(route) {
  const text = readSkillFile('references/index-' + route + '.md');
  if (!text) return '';
  return text.length > INDEX_CHAR_LIMIT ? text.slice(0, INDEX_CHAR_LIMIT) + '\n……（卡片表已截断）' : text;
}

// 第一步：照技能的 Progressive Disclosure，先路由到 1~2 个风格族。
// 路由只是「选读哪张卡片表」，失败不影响改写本身 —— 按技能规定退回 general-pop-ballad。
async function routeFamilies(llm, router, caption) {
  try {
    const out = await llmChat(llm, [
      {
        role: 'system',
        content: [
          '你是 music-caption-rewriter 技能的风格路由器。下面是该技能的 Genre Router 文档：',
          router,
          '只做风格路由，不要写 caption。根据用户的音乐描述，从 Family map 中选出 primary（必选）与 secondary（只有在明确要求融合风格或需要对照色彩时才给，否则留空）。',
          '只输出 JSON：{"primary":"<route>","secondary":"<route 或空字符串>"}',
        ].join('\n\n'),
      },
      { role: 'user', content: '音乐描述：' + caption },
    ], { json: true, temperature: 0.2, maxTokens: 600, timeoutMs: 120000 });

    const data = extractJson(out.content || '{}');
    const primaryRaw = String(data.primary || '').trim();
    const secondaryRaw = String(data.secondary || '').trim();
    const primary = FAMILIES.has(primaryRaw) ? primaryRaw : 'general-pop-ballad';
    const secondary = FAMILIES.has(secondaryRaw) && secondaryRaw !== primary ? secondaryRaw : '';
    return { primary, secondary };
  } catch {
    return { primary: 'general-pop-ballad', secondary: '' };
  }
}

/**
 * 按 music-caption-rewriter 技能重写音乐描述与歌词。
 * @returns {Promise<{caption: string, lyrics: string, primary: string, secondary: string}>}
 */
export async function optimizeMusicBrief({ llm, caption, lyrics, duration, style }) {
  const srcCaption = String(caption || '').trim();
  if (!srcCaption) throw new Error('缺少音乐描述 caption');

  const skill = stripFrontmatter(readSkillFile('SKILL.md'));
  if (!skill) throw new Error('未找到 skills/' + SKILL_NAME + '/SKILL.md');
  const router = readSkillFile('references/genre-router.md');
  if (!router) throw new Error('未找到 skills/' + SKILL_NAME + '/references/genre-router.md');

  const { primary, secondary } = await routeFamilies(llm, router, srcCaption);
  const cards = [primary, secondary]
    .filter(Boolean)
    .map((route) => '### Family index: ' + route + '\n' + familyCards(route))
    .filter((block) => block.trim())
    .join('\n\n');

  const system = [
    '你在执行 music-caption-rewriter 技能：把用户给出的音乐描述与歌词，改写成可直接驱动 MiniMax Music 3 的结构化 caption，并把歌词整理成可编曲版本。',
    '以下是技能正文，必须严格遵守它的输入约束、输出契约与自检清单：',
    '<skill_content>',
    skill,
    '</skill_content>',
    '',
    '本次一次性改写的补充约定：',
    '1. 只输出一个 JSON 对象：{"caption":"…","lyrics":"…"}；不要 markdown 代码块、不要解释、不要推理过程。',
    '2. caption 必须用英文书写，并包含且只包含这三个三级标题：### Global Metadata、### Vocal Details、### Arrangement（顺序固定）。',
    '3. caption 中禁止出现任何歌词原文、歌名、模板 ID、路由诊断。',
    '4. 原始歌词为空时，lyrics 必须返回空字符串（保持纯音乐），且 Vocal Details 要明确写出这是 instrumental。',
    '5. 原始歌词非空时，视为有人声演唱：Vocal Details 必须描述实际人声，不能写成 instrumental；保留原语言与原意，不翻译、不新增叙事内容，只补充 [Intro]/[Verse]/[Pre-Chorus]/[Chorus]/[Bridge]/[Outro] 段落标签并按演唱与编曲顺序重排（副歌可重复），让它可以直接编曲。',
    '6. 不得改写用户明确要求的风格、乐器、人声性别、语言、时长等约束；用户没说的不要编造精确 BPM/调性，也不要写「未指定 BPM/调性」这类元信息，直接用定性的速度与调性描述。',
  ].join('\n');

  const user = [
    '原始音乐描述 caption：\n' + srcCaption,
    '原始歌词（可为空）：\n' + (String(lyrics || '').trim() || '（无，纯音乐）'),
    duration ? '期望时长：' + duration + ' 秒' : '',
    style ? '画面/项目风格（仅作情绪参考，不要照抄）：' + style : '',
    cards ? '已按路由读到的风格卡片（仅用于校准风格，不要照抄句子）：\n' + cards : '',
    '请输出 JSON。',
  ].filter(Boolean).join('\n\n');

  // JSON 偶发被代理/限流截断：重试一次再放弃，避免整段优化白跑。
  let nextCaption = '';
  let nextLyrics = '';
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await llmChat(llm, [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], { json: true, temperature: 0.7, maxTokens: 4096, timeoutMs: 300000 });
      const data = extractJson(out.content || '{}');
      nextCaption = String(data.caption || '').trim();
      nextLyrics = String(data.lyrics || '').trim();
      if (nextCaption) break;
      lastError = new Error('LLM 未返回优化后的 caption');
    } catch (e) {
      lastError = e;
      // 超时/连不上重试只会把等待翻倍（llmChat 自身已是长超时），直接交给调用方退回原始输入。
      if (/超时|无法连接|请求失败/.test(String(e?.message || ''))) break;
    }
  }
  if (!nextCaption) throw lastError || new Error('LLM 未返回优化后的 caption');
  const srcLyrics = String(lyrics || '').trim();
  if (!srcLyrics) nextLyrics = '';
  else if (!nextLyrics) nextLyrics = srcLyrics;

  return { caption: nextCaption, lyrics: nextLyrics, primary, secondary };
}
