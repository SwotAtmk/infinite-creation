#!/usr/bin/env node
// 安装短剧技能包：short-drama-main.zip + manju-laoli-skill-main.zip → skills/
// 用法：node scripts/install-short-drama-packs.mjs（或 pnpm install:short-drama-packs）
// 行为：规范化 short-drama-main 的 frontmatter → installSkillsFromZip（临时目录）→ 覆盖到 skills/ → scanSkills
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { installSkillsFromZip, scanSkills } from '../lib/agent/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

const PACKS = ['short-drama-main.zip', 'manju-laoli-skill-main.zip'];

// 原包没有 frontmatter：补 name + description，并把安装目录改成语义化名称。
// 目录名必须与 frontmatter name 一致（skill(name) 按目录名加载）。
const NORMALIZE = {
  'short-drama-main.zip': {
    dir: 'short-drama-main',
    name: 'short-drama-scriptwriting',
    description: '微短剧剧本创作：从选题定位、故事骨架、角色档案、分集目录到 50-100 集分集剧本的完整编剧方法论；覆盖 13 种爆款题材、开场钩子、付费卡点、节奏曲线、爽感矩阵、反派体系与合规清单。触发词：微短剧、短剧剧本、分集剧本、爆款短剧、付费卡点、钩子设计、爽感矩阵。',
  },
};

// 统一换行符，并把 frontmatter 整体替换为规范的单行 name + description（无则前置）。
function setFrontmatter(text, { name, description }) {
  const t = String(text).replace(/^\ufeff/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const fm = '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n';
  const m = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(t);
  return m ? fm + t.slice(m[0].length) : fm + t;
}

function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-skill-packs-'));
  const installed = [];
  try {
    for (const file of PACKS) {
      const abs = path.join(ROOT, file);
      if (!fs.existsSync(abs)) throw new Error('未找到技能包：' + abs);
      let buf = fs.readFileSync(abs);
      const spec = NORMALIZE[file];
      if (spec) {
        const zip = new AdmZip(buf);
        const entry = zip.getEntries().find((e) => !e.isDirectory && /(^|\/)SKILL(\.cn)?\.md$/i.test(e.entryName));
        if (!entry) throw new Error(file + ' 未找到 SKILL.md');
        const raw = entry.getData().toString('utf8');
        zip.updateFile(entry.entryName, Buffer.from(setFrontmatter(raw, spec), 'utf8'));
        buf = zip.toBuffer();
      }
      const list = installSkillsFromZip(buf, { sourceName: file, targetDir: temp });
      for (const item of list) {
        const targetName = spec && item.name === spec.dir ? spec.name : item.name;
        const src = path.join(temp, item.name);
        const dest = path.join(SKILLS_DIR, targetName);
        // 覆盖安装：先删旧目录，避免 installSkillsFromZip 的 _2 后缀产生重复技能
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(src, dest, { recursive: true });
        installed.push({ name: targetName, files: item.files });
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const skills = scanSkills();
  console.log('已安装 ' + installed.length + ' 个技能目录：');
  for (const s of installed) console.log('  - ' + s.name + '（' + s.files + ' 文件）');
  console.log('扫描注册技能总数：' + skills.length);
}

main();
