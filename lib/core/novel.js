import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './config.js';

// —— 无限・卷轴：小说项目读写共享模块 ——
// 所有 novel 类型相关的文件路径、读写、序列化都收敛在此处，
// 避免 agent-loop.js / novel/route.js / import/route.js 各自各写一份。

const STRUCTURE_FILES = {
  outline: '总纲.md',
  volumes: '卷纲.md',
  chapters: '章纲.md',
};
const CHARACTERS_FILE = 'characters.json';
const VOLUMES_FILE = 'volumes.json';
const MEMORY_DIR = 'memory';

function novelDir(projectId) {
  return path.join(projectDir(projectId), 'novel');
}

function safeRel(p) {
  // 仅允许 novel 目录下的相对路径，禁止 ../ 与绝对路径
  if (!p) return null;
  const s = String(p).replace(/\\/g, '/');
  if (path.isAbsolute(s) || s.startsWith('/')) return null;
  if (s.includes('..')) return null;
  return s;
}

function readMaybe(filePath, encoding = 'utf-8') {
  try {
    return fs.readFileSync(filePath, encoding);
  } catch {
    return '';
  }
}

function safeMkdir(dirPath) {
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch {}
}

function safeWrite(filePath, content) {
  safeMkdir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

function loadCharacters(filePath) {
  try {
    const txt = fs.readFileSync(filePath, 'utf-8');
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveCharacters(filePath, characters) {
  safeMkdir(path.dirname(filePath));
  const cleaned = (Array.isArray(characters) ? characters : []).map((c) => ({
    id: String(c.id || ''),
    name: String(c.name || ''),
    role: String(c.role || ''),
    description: String(c.description || ''),
    notes: c.notes != null ? String(c.notes) : '',
  })).filter((c) => c.name || c.role || c.description);
  fs.writeFileSync(filePath, JSON.stringify(cleaned, null, 2), 'utf-8');
  return cleaned;
}

// —— 结构化「卷」：每卷有卷号、卷名、本卷卷纲、覆盖章节范围 ——
// 存储在 novel/volumes.json，形如：
// [{ id, seq, title, outline, chapterFrom, chapterTo }]
function normalizeVolumes(volumes) {
  return (Array.isArray(volumes) ? volumes : []).map((v, i) => ({
    id: String(v.id || ''),
    seq: Number.isFinite(Number(v.seq)) && Number(v.seq) >= 1 ? Math.floor(Number(v.seq)) : i + 1,
    title: String(v.title || ''),
    outline: String(v.outline || ''),
    chapterFrom: Number.isFinite(Number(v.chapterFrom)) ? Math.floor(Number(v.chapterFrom)) : 0,
    chapterTo: Number.isFinite(Number(v.chapterTo)) ? Math.floor(Number(v.chapterTo)) : 0,
  })).filter((v) => v.title || v.outline || v.chapterFrom || v.chapterTo)
    .sort((a, b) => a.seq - b.seq);
}

function loadVolumes(filePath) {
  try {
    const txt = fs.readFileSync(filePath, 'utf-8');
    return normalizeVolumes(JSON.parse(txt));
  } catch {
    return [];
  }
}

function saveVolumes(filePath, volumes) {
  const cleaned = normalizeVolumes(volumes);
  safeMkdir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(cleaned, null, 2), 'utf-8');
  return cleaned;
}

// 读 memory 目录下所有文件：[{ name, content }]
function loadMemory(memoryDir) {
  const out = [];
  try {
    if (!fs.existsSync(memoryDir)) return out;
    const entries = fs.readdirSync(memoryDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const name = e.name;
      if (name.startsWith('.')) continue;
      const content = readMaybe(path.join(memoryDir, name));
      out.push({ name, content });
    }
  } catch {}
  return out;
}

// 列出 novel 目录下所有文件（递归）
export function listNovelFiles(projectId) {
  const base = novelDir(projectId);
  const out = [];
  function walk(dir, rel) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const rp = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rp);
        else out.push(rp.split(path.sep).join('/'));
      }
    } catch {}
  }
  if (fs.existsSync(base)) walk(base, '');
  return out;
}

// 读 novel 下任意文件（越界防护由 safeRel + path.resolve 自然挡住）
export function readNovelFile(projectId, relPath) {
  const rp = safeRel(relPath);
  if (!rp) return null;
  const abs = path.resolve(novelDir(projectId), rp);
  const base = novelDir(projectId);
  const inside = path.relative(base, abs);
  if (!inside || inside.startsWith('..')) return null;
  if (!fs.existsSync(abs)) return '';
  return readMaybe(abs);
}

export function writeNovelFile(projectId, relPath, content) {
  const rp = safeRel(relPath);
  if (!rp) return null;
  const abs = path.resolve(novelDir(projectId), rp);
  const base = novelDir(projectId);
  const inside = path.relative(base, abs);
  if (!inside || inside.startsWith('..')) return null;
  safeWrite(abs, String(content || ''));
  return abs;
}

// —— 面向 API / Agent 的高层读写 ——

export function loadNovelState(projectId) {
  const base = novelDir(projectId);
  const structure = {};
  for (const [k, f] of Object.entries(STRUCTURE_FILES)) {
    structure[k] = readMaybe(path.join(base, f));
  }
  const characters = loadCharacters(path.join(base, CHARACTERS_FILE));
  const volumes = loadVolumes(path.join(base, VOLUMES_FILE));
  const memory = loadMemory(path.join(base, MEMORY_DIR));
  return { structure, characters, volumes, memory };
}

export function saveNovelState(projectId, { structure, characters, volumes, memory }) {
  const base = novelDir(projectId);
  safeMkdir(base);
  if (structure && typeof structure === 'object') {
    for (const [k, f] of Object.entries(STRUCTURE_FILES)) {
      if (structure[k] != null) {
        safeWrite(path.join(base, f), String(structure[k]));
      }
    }
  }
  if (characters != null) {
    saveCharacters(path.join(base, CHARACTERS_FILE), characters);
  }
  if (volumes != null) {
    saveVolumes(path.join(base, VOLUMES_FILE), volumes);
  }
  if (Array.isArray(memory)) {
    const memDir = path.join(base, MEMORY_DIR);
    safeMkdir(memDir);
    // 清空旧文件再写
    try {
      for (const e of fs.readdirSync(memDir)) {
        try { fs.unlinkSync(path.join(memDir, e)); } catch {}
      }
    } catch {}
    for (const m of memory) {
      if (!m || !m.name) continue;
      safeWrite(path.join(memDir, m.name), String(m.content || ''));
    }
  }
}

// 给 Agent 上下文引擎用：把 novel 目录里已有的结构拼成一段可读文本
export function buildNovelContextBlock(projectId) {
  const { structure, characters, volumes, memory } = loadNovelState(projectId);
  const parts = [];
  if (structure.outline) parts.push('【现有总纲】\n' + structure.outline);
  if (volumes.length) {
    const lines = volumes.map((v) => {
      const range = v.chapterFrom || v.chapterTo
        ? `（第${v.chapterFrom || '?'}章 ~ 第${v.chapterTo || '?'}章）`
        : '';
      return `## 第${v.seq}卷 ${v.title}${range}\n${v.outline}`;
    });
    parts.push('【现有分卷（结构化卷纲）】\n' + lines.join('\n\n'));
  }
  if (structure.volumes) parts.push('【现有卷纲汇总】\n' + structure.volumes);
  if (structure.chapters) parts.push('【现有章纲汇总】\n' + structure.chapters);
  if (characters.length) {
    const lines = characters.map((c) => `- ${c.name}（${c.role || '未标注'}）：${c.description || ''}`);
    parts.push('【现有角色】\n' + lines.join('\n'));
  }
  if (memory.length) {
    const lines = memory.map((m) => `# ${m.name}\n${m.content}`);
    parts.push('【上下文记忆】\n' + lines.join('\n\n'));
  }
  return parts.join('\n\n');
}

// 把 novel 状态拼成「导入到 Agent 无限创作」的文档
export function buildImportDocument({ name, idea, structure, characters, volumes }) {
  const lines = [];
  lines.push('# ' + (name || '未命名小说'));
  if (idea) lines.push('\n## 中心思想\n' + idea);
  if (structure?.outline) lines.push('\n## 总纲\n' + structure.outline);
  if (Array.isArray(volumes) && volumes.length) {
    lines.push('\n## 卷纲（分卷）');
    for (const v of volumes) {
      const range = v.chapterFrom || v.chapterTo ? `（第${v.chapterFrom || '?'}章 ~ 第${v.chapterTo || '?'}章）` : '';
      lines.push(`\n### 第${v.seq}卷 ${v.title}${range}\n${v.outline}`);
    }
  } else if (structure?.volumes) {
    lines.push('\n## 卷纲\n' + structure.volumes);
  }
  if (structure?.chapters) lines.push('\n## 章纲\n' + structure.chapters);
  if (characters?.length) {
    lines.push('\n## 角色设定');
    for (const c of characters) {
      lines.push(`- **${c.name}**（${c.role || '未标注'}）：${c.description || ''}`);
    }
  }
  return lines.join('\n');
}

// 校验 step 值（agent 任务路由用）
export const NOVEL_STEPS = ['outline', 'volumes', 'chapters', 'write', 'start', 'extend', 'restart', 'all'];
export function isValidNovelStep(step) {
  return NOVEL_STEPS.includes(String(step || '').toLowerCase());
}
