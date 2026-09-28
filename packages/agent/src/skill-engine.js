import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { SKILLS_DIR, Skills, slugify, uid } from '@ic/core';

// 解析 SKILL.md 的 YAML frontmatter（name / description 单行）
export function parseFrontmatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text || '');
  if (!m) return {};
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      let v = line.slice(idx + 1).trim();
      v = v.replace(/^['"]|['"]$/g, '');
      meta[k] = v;
    }
  }
  return meta;
}

// 读取技能主体（frontmatter 之后的内容）
export function stripFrontmatter(text) {
  const m = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(text || '');
  return m ? text.slice(m[0].length) : (text || '');
}

export function skillDir(name) { return path.join(SKILLS_DIR, name); }

export function readSkillFile(name) {
  const dir = skillDir(name);
  const cn = path.join(dir, 'SKILL.cn.md');
  const en = path.join(dir, 'SKILL.md');
  let file = en;
  if (fs.existsSync(cn)) file = cn; // 中文优先
  else if (!fs.existsSync(en)) return null;
  return fs.readFileSync(file, 'utf8');
}

// 扫描 skills/ 目录，解析 frontmatter 并注册到 DB
export function scanSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const result = [];
  for (const name of fs.readdirSync(SKILLS_DIR)) {
    const dir = skillDir(name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const text = readSkillFile(name);
    if (!text) continue;
    const meta = parseFrontmatter(text);
    const skillName = meta.name || name;
    const metaYaml = path.join(dir, 'meta.yaml');
    const manifest = fs.existsSync(metaYaml) ? { metaYaml: true } : {};
    const s = Skills.upsert({
      name: skillName,
      description: meta.description || '',
      version: manifest.version || '',
      source: name === 'novel-to-video' ? 'bundled' : 'installed',
      enabled: true,
      path: 'skills/' + name,
      manifest,
    });
    result.push(s);
  }
  return result;
}

export function loadSkill(name) {
  const text = readSkillFile(name);
  if (!text) return null;
  const meta = parseFrontmatter(text);
  return { name: meta.name || name, description: meta.description || '', body: stripFrontmatter(text) };
}

// 加载技能的 references 目录（可选，供需要时注入）
export function loadSkillReferences(name) {
  const dir = path.join(skillDir(name), 'references');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') || f.endsWith('.txt')).map((f) => ({
    name: f,
    content: fs.readFileSync(path.join(dir, f), 'utf8'),
  }));
}

// 技能目录（仅摘要：name/description/whenToUse，供模型发现技能）
export function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const result = [];
  for (const name of fs.readdirSync(SKILLS_DIR)) {
    const dir = skillDir(name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const text = readSkillFile(name);
    if (!text) continue;
    const meta = parseFrontmatter(text);
    result.push({ name: meta.name || name, description: meta.description || '', whenToUse: meta.whenToUse || '' });
  }
  return result.sort((a, b) => (a.name < b.name ? -1 : 1));
}

// 把技能正文渲染为模型可读的 <skill_content> 块（对齐 DSH renderSkillContent）
export function renderSkillContent(skill) {
  const name = skill?.name || '';
  const body = skill?.body || skill?.content || '';
  const base = skill?.resourceBase || '';
  const resourceLines = base
    ? ['<skill_resources>', 'Base directory for this skill: ' + base, 'Resolve relative paths against this base directory before using them. Load referenced resources only as needed.', '</skill_resources>', '']
    : [];
  return ['<skill_content name="' + name + '">', ...resourceLines, '<skill_instructions>', body, '</skill_instructions>', '</skill_content>'].join('\n');
}

// 一次返回技能正文 + references（供按需加载工具使用）
export function loadSkillWithResources(name) {
  const skill = loadSkill(name);
  if (!skill) return null;
  return { ...skill, references: loadSkillReferences(name), resourceBase: skillDir(name) };
}

// 技能路由：优先用户显式指定，其次关键词，最后默认 novel-to-video
const KEYWORD_ROUTES = [
  // 短剧/漫剧创作（更具体的关键词在前，避免被下方 3D/动画短片 等通用词抢占）
  { re: /年代一致|道具一致|时代错误|维多利亚|近未来/, skill: 'era-consistency-optimizer' },
  { re: /全栈技能包|14要素|五维框架|运镜模板/, skill: 'manga-full-stack' },
  { re: /前期策划|漫剧策划|世界观构建/, skill: 'ai-manga-planner' },
  { re: /漫剧导演|帮我做.*漫剧|做一集漫剧|小说转漫剧/, skill: 'manju-director-agent' },
  { re: /文字分镜|可拍摄分镜|分镜.*JSON/, skill: 'hf-drama-storyboard-script' },
  { re: /小说转剧本|小说改编|短剧改编|漫剧改编|novel.?to.?screenplay/, skill: 'novel-to-skitscreenplay' },
  { re: /剧本转分镜|转分镜脚本|novel.?to.?storyboard/, skill: 'novel-to-storyboard' },
  { re: /脚本转漫剧|剧本转.*漫剧|生成漫剧提示词|script.?to.?manga/, skill: 'script-to-manga' },
  { re: /漫剧分镜解析|3D漫剧|comic.?drama/, skill: 'comic-drama-generator' },
  { re: /镜头库|影视级|cinematic.*comic|漫剧生成|漫剧制作/, skill: 'cinematic-ai-comic-director' },
  { re: /编剧|大纲扩写|逐集|70.?90集|0715/, skill: '0715-scriptwriter' },
  { re: /剧本创作|剧本总控|交付剧本|给甲方/, skill: 'script-master' },
  { re: /漫剧全流程|小说转动漫|manga.?drama/, skill: 'manga-drama-generator' },
  { re: /短剧|漫剧|微短剧|竖屏剧/, skill: 'micro-drama-creator' },
  { re: /3d|三维|3D|动画短片/, skill: '3d-animation-short-generator' },
  { re: /纸艺|剪纸|stop.motion|定格/, skill: 'papercraft-stop-motion-explainer' },
  { re: /手绘|hand.drawn|live/, skill: 'handdrawn-live-video-generator' },
  { re: /产品广告|promo|带货|广告/, skill: 'brand-promo-video-generator' },
  { re: /音乐视频|MV|歌词|字幕/, skill: 'music-video-subtitle-generator' },
  { re: /游戏开场|co.op|双人游戏/, skill: 'co-op-game-intro-generator' },
  { re: /极简|minimalist|电商/, skill: 'minimalist-product-ad-generator' },
  { re: /纸拼贴|collage|知识科普/, skill: 'paper-collage-explainer-generator' },
];

export function routeSkill(taskDescription, explicitStyle) {
  const text = String(explicitStyle || '') + ' ' + String(taskDescription || '');
  for (const r of KEYWORD_ROUTES) {
    if (r.re.test(text)) return r.skill;
  }
  return 'novel-to-video';
}

// —— zip 技能包安装 ——

const SKILL_MD_FILES = new Set(['SKILL.md', 'SKILL.cn.md']);

// 校验并归一化 zip 条目路径：反斜杠→正斜杠、去前导斜杠、按 / 切分；拒绝盘符绝对路径与 .. 越界。
// 返回段数组；非法返回 null。
function safeZipParts(entryName) {
  const s = String(entryName || '').replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(s)) return null;
  const parts = s.split('/').filter((seg) => seg.length > 0);
  if (parts.some((seg) => seg === '..')) return null;
  return parts;
}

/**
 * 从 zip 缓冲区安装技能到 targetDir（默认 SKILLS_DIR）。
 * 每个「含 SKILL.md / SKILL.cn.md 的目录」视为一个技能；根位于 zip 顶层时整包视为单技能。
 * 纯文件操作、不触库；返回 [{ name, dir, files }]。
 */
export function installSkillsFromZip(buffer, { sourceName = '', targetDir = SKILLS_DIR } = {}) {
  let zip;
  try { zip = new AdmZip(buffer); } catch (e) { throw new Error('无法解析 zip 文件：' + e.message); }
  const entries = zip.getEntries();
  if (!entries || !entries.length) throw new Error('zip 文件为空');

  const files = []; // { parts, entry }
  for (const entry of entries) {
    const parts = safeZipParts(entry.entryName);
    if (!parts) throw new Error('zip 含不安全路径：' + entry.entryName);
    if (entry.isDirectory || parts.length === 0) continue;
    files.push({ parts, entry });
  }

  const roots = files.filter((f) => SKILL_MD_FILES.has(f.parts[f.parts.length - 1]));
  if (!roots.length) throw new Error('未在 zip 中找到 SKILL.md 或 SKILL.cn.md');

  // 按父目录深度降序处理：嵌套技能的文件优先归属更深技能根，避免误并入父技能。
  const rootList = roots
    .map((f) => ({ file: f, parent: f.parts.slice(0, -1) }))
    .sort((a, b) => b.parent.length - a.parent.length);

  // 每个文件归属「最深匹配」的技能根。
  const assigned = new Map();
  for (let i = 0; i < rootList.length; i++) {
    const prefix = rootList[i].parent;
    for (let j = 0; j < files.length; j++) {
      if (assigned.has(j)) continue;
      const p = files[j].parts;
      if (prefix.length === 0) {
        assigned.set(j, i); // 根在 zip 顶层：吸收所有未归属文件（更深根已优先处理）
      } else if (p.length > prefix.length && p.slice(0, prefix.length).join('/') === prefix.join('/')) {
        assigned.set(j, i);
      }
    }
  }

  const used = new Set();
  const installed = [];
  for (let i = 0; i < rootList.length; i++) {
    const { file: rootFile, parent } = rootList[i];
    let dirName;
    if (parent.length === 0) {
      const md = rootFile.entry.getData().toString('utf8');
      const metaName = parseFrontmatter(md).name;
      dirName = slugify(metaName || String(sourceName).replace(/\.zip$/i, '') || 'skill');
    } else {
      dirName = slugify(parent[parent.length - 1]);
    }
    if (!dirName) dirName = 'skill_' + uid().slice(0, 6);
    let finalName = dirName;
    let k = 2;
    while (used.has(finalName)) finalName = dirName + '_' + (k++);
    used.add(finalName);

    let wrote = 0;
    for (let j = 0; j < files.length; j++) {
      if (assigned.get(j) !== i) continue;
      const parts = files[j].parts;
      const relParts = parent.length === 0 ? parts : parts.slice(parent.length);
      const abs = path.join(targetDir, finalName, ...relParts);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, files[j].entry.getData());
      wrote++;
    }
    installed.push({ name: finalName, dir: finalName, files: wrote });
  }
  return installed;
}
