#!/usr/bin/env node
// 从 MiniMax-AI/MiniMax-H3 仓库拉取官方技能到 skills/（默认 9 个）。
// 用法：node scripts/install-skills.mjs [--ref <commit>] [--only <name>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const REPO = 'MiniMax-AI/MiniMax-H3';

const args = process.argv.slice(2);
const refIdx = args.indexOf('--ref');
const REF = refIdx !== -1 ? args[refIdx + 1] : 'main';
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

const API = 'https://api.github.com';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ic-install-skills', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error('GET ' + url + ' -> ' + res.status);
  return res.json();
}

// raw.githubusercontent.com 可能被墙，改用 contents API + Accept: raw
async function download(repoPath, dest) {
  const url = API + '/repos/' + REPO + '/contents/' + repoPath + '?ref=' + REF;
  const res = await fetch(url, { headers: { 'User-Agent': 'ic-install-skills', Accept: 'application/vnd.github.raw' } });
  if (!res.ok) throw new Error('GET ' + url + ' -> ' + res.status);
  const text = await res.text();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text, 'utf8');
  return dest;
}

async function main() {
  // 1) 递归树
  const treeUrl = API + '/repos/' + REPO + '/git/trees/' + REF + '?recursive=1';
  const tree = await fetchJson(treeUrl);
  if (tree.truncated) console.warn('[warn] 仓库树被截断，可能漏掉部分文件');
  const skillsFiles = (tree.tree || [])
    .filter((e) => e.type === 'blob' && e.path.startsWith('skills/'))
    .map((e) => e.path);

  if (!skillsFiles.length) throw new Error('未找到 skills/ 下的文件，检查 ref：' + REF);

  // 2) 过滤：只要 SKILL.md / SKILL.cn.md / meta.yaml / references/** / agents/**
  const interesting = skillsFiles.filter((p) => {
    const base = path.basename(p);
    return base === 'SKILL.md' || base === 'SKILL.cn.md' || base === 'meta.yaml'
      || p.includes('/references/') || p.includes('/agents/');
  });

  const bySkill = new Map();
  for (const p of interesting) {
    const parts = p.split('/'); // skills/<name>/...
    const name = parts[1];
    if (!bySkill.has(name)) bySkill.set(name, []);
    bySkill.get(name).push(p);
  }

  const names = [...bySkill.keys()].filter((n) => !ONLY || n === ONLY);
  console.log('将安装 ' + names.length + ' 个技能 @ ' + REF + '：');
  names.forEach((n) => console.log('  - ' + n));

  let count = 0;
  for (const name of names) {
    for (const p of bySkill.get(name)) {
      const rel = p.slice('skills/'.length); // <name>/SKILL.md ...
      const dest = path.join(SKILLS_DIR, rel);
      try {
        await download(p, dest);
        count++;
      } catch (e) {
        console.warn('[warn] ' + e.message);
      }
    }
  }
  console.log('完成：写入 ' + count + ' 个文件到 skills/');
}

main().catch((e) => { console.error('[error] ' + e.message); process.exit(1); });
