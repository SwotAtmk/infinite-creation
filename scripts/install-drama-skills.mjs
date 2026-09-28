#!/usr/bin/env node
// 安装「生产级专业短剧剧本 Ai 辅助创作 skills 合集」里的短剧/漫剧技能到 skills/。
// 用法：node scripts/install-drama-skills.mjs
// 行为：MD5 去重（剔除字节级重复包）→ 规范化 3 个技能的 frontmatter → installSkillsFromZip → scanSkills。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { installSkillsFromZip, scanSkills } from '../lib/agent/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, '生产级专业短剧剧本 Ai 辅助创作 skills 合集');

// 需要规范化 frontmatter 的包（按 zip 文件名键控）：
// - 无 frontmatter 的补 name + description（保证目录名 == name，skill() 才能按名加载）；
// - description: > 折叠多行的改写为单行（现有 parseFrontmatter 只识别单行）。
const NORMALIZE = {
  'AI 漫剧全流程生成技能.zip': {
    name: 'manga-drama-generator',
    description: 'AI漫剧全流程一键生成技能。将小说内容转化为AI动漫短剧制作所需的全套素材：专业剧本、人物设定（信息提取+小传+视觉关键词+三视图提示词）、场景设定（提取+场景提示词）、分镜脚本（拆分+首帧/尾帧/视频提示词）、以及标准化Excel表格输出。当用户需要将小说转化为漫剧/动漫短剧、生成分镜脚本、生成AI绘图提示词，或提及漫剧生成、小说转动漫、AI短剧时使用。'
  },
  'AI漫剧全栈技能包.zip': {
    name: 'manga-full-stack',
    description: 'AI漫剧全栈技能包：基于19份专业资料整合的AI漫剧全流程制作技能，覆盖分镜提示词（14要素公式）、角色一致性控制（五维框架+参考图锁定+参数固化）、剧本结构设计（三段式+万能故事公式）、多风格体系（3D动漫/古风玄幻/赛博朋克/暗黑悬疑）与50+运镜提示词模板。'
  },
  'AI漫剧道具一致性提示词优化.zip': {
    name: 'era-consistency-optimizer',
    description: '年代一致性优化器：优化AIGC漫剧提示词，确保场景中出现的所有道具、科技产品、服饰、建筑、交通工具等元素与指定年代完全匹配，避免出现时代错误物体，提升生成内容的真实感与专业度。触发：明确或隐含的时代背景（如唐朝、90年代中国、维多利亚时期、近未来2045年等）。'
  }
};

// 统一换行符；若给定 spec，则把 frontmatter 整体替换为规范的单行 name + description（无则前置）。
function setFrontmatter(text, { name, description }) {
  let t = String(text).replace(/^\ufeff/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const fm = '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n';
  const m = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(t);
  if (m) return fm + t.slice(m[0].length);
  return fm + t;
}

function normalizeSkillMd(text, sourceName) {
  const spec = NORMALIZE[sourceName];
  if (spec) return setFrontmatter(text, spec);
  return String(text).replace(/^\ufeff/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function main() {
  if (!fs.existsSync(SRC_DIR)) throw new Error('未找到合集目录：' + SRC_DIR);
  const zips = fs.readdirSync(SRC_DIR).filter((f) => f.toLowerCase().endsWith('.zip'));

  // MD5 去重
  const seen = new Map();
  const unique = [];
  for (const f of zips) {
    const buf = fs.readFileSync(path.join(SRC_DIR, f));
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    if (seen.has(md5)) { console.log('[跳过重复] ' + f + '（同 ' + seen.get(md5) + '）'); continue; }
    seen.set(md5, f);
    unique.push({ f, buf });
  }
  console.log('发现 ' + zips.length + ' 个 zip，去重后 ' + unique.length + ' 个。');

  const installed = [];
  for (const { f, buf } of unique) {
    const zip = new AdmZip(buf);
    const mdEntry = zip.getEntries().find((e) => !e.isDirectory && /(^|\/)SKILL(\.cn)?\.md$/i.test(e.entryName));
    if (!mdEntry) { console.warn('[warn] ' + f + ' 未找到 SKILL.md，跳过规范化'); }
    else {
      const raw = mdEntry.getData().toString('utf8');
      const normalized = normalizeSkillMd(raw, f);
      if (normalized !== raw) { zip.updateFile(mdEntry.entryName, Buffer.from(normalized, 'utf8')); }
    }
    const res = installSkillsFromZip(zip.toBuffer(), { sourceName: f });
    installed.push(...res);
  }

  const skills = scanSkills();
  console.log('已安装 ' + installed.length + ' 个技能目录：');
  for (const s of installed) console.log('  - ' + s.name + '（' + s.files + ' 文件）');
  console.log('扫描注册技能总数：' + skills.length);
  for (const s of skills) {
    const d = (s.description || '').slice(0, 60);
    console.log('  · ' + s.name + ' :: ' + (d || '(空描述)'));
  }
}

main();
