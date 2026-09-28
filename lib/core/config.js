import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDebug } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// lib/core/config.js -> lib/core -> lib -> 仓库根
export const ROOT = path.resolve(__dirname, '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const DB_PATH = path.join(DATA_DIR, 'ic.db');
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const WORKFLOWS_DIR = path.join(ROOT, 'workflows');
export const SKILLS_DIR = path.join(ROOT, 'skills');

const DEFAULTS = {
  debug: false,
  server: { port: 4600 },
  comfyui: { baseUrl: 'http://127.0.0.1:8188' },
  llm: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', tools: true, vision: false },
  generation: { imageConcurrency: 2, videoConcurrency: 1, retryTimes: 3, videoTimeoutMinutes: 30, imageTimeoutMinutes: 10 },
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function ensureDirs() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

export function loadConfig() {
  ensureDirs();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  const merged = deepMerge(structuredClone(DEFAULTS), cfg);
  setDebug(!!merged.debug);
  return merged;
}

export function saveConfig(cfg) {
  ensureDirs();
  const merged = deepMerge(structuredClone(DEFAULTS), cfg);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  setDebug(!!merged.debug);
  return merged;
}

export function projectDir(projectId) {
  return path.join(PROJECTS_DIR, projectId);
}

export function ensureProjectDirs(projectId) {
  const base = projectDir(projectId);
  const dirs = [
    path.join(base, 'novel'),
    ...['characters', 'scenes', 'props', 'costumes', 'voice', 'music', 'sfx', 'other'].map((c) => path.join(base, 'assets', c)),
    path.join(base, 'storyboard'),
    path.join(base, 'shots'),
    path.join(base, 'exports'),
    path.join(base, 'logs'),
    path.join(base, 'context'),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  return base;
}
