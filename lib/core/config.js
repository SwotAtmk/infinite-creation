import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDebug } from './logger.js';
import { HW_MODES, HW_PRESETS, HW_DEFAULT_FREE, hardwareMode, isPresetWorkflows } from '../shared/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// lib/core/config.js -> lib/core -> lib -> 仓库根
export const ROOT = path.resolve(__dirname, '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const DB_PATH = path.join(DATA_DIR, 'ic.db');
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const WORKFLOWS_DIR = path.join(ROOT, 'workflows');
export const SKILLS_DIR = path.join(ROOT, 'skills');

// —— 硬件模式：一键切换「英伟达原版工作流」与「AMD + GGUF 适配工作流」 ——
// 常量与判定函数定义在 lib/shared（纯数据，设置页也直接引用同一份），这里只做转出与配置解析。
export { HW_MODES, HW_PRESETS, HW_DEFAULT_FREE, hardwareMode } from '../shared/index.js';

const DEFAULTS = {
  debug: false,
  server: { port: 4600 },
  comfyui: { baseUrl: 'http://127.0.0.1:8188' },
  llm: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'DeepSeek-V4.1-Flash', tools: true, vision: false },
  hardware: { mode: 'nvidia' },
  // 并发数按 ComfyUI 单队列串行执行的实际吞吐定：视频单条 15-30 分钟，超时须覆盖排队时间。
  // freeAfterEvery = 「生成维护」每 N 个 ComfyUI 生成任务释放一次显存（0 = 关闭）。
  // 默认值由 hardware.mode 推导（HW_DEFAULT_FREE），loadConfig 里统一解析；旧键 videoFreeAfterEvery 在 loadConfig 时迁移。
  generation: { imageConcurrency: 2, videoConcurrency: 1, retryTimes: 3, videoTimeoutMinutes: 90, imageTimeoutMinutes: 30, freeAfterEvery: 0 },
  // workflows 默认 = HW_PRESETS.nvidia；loadConfig 按 hardware.mode 推导，勿直接改这里
  workflows: HW_PRESETS.nvidia,
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

// 把 hardware.mode 解析成实际生效配置：
//   1) workflows 以对应模式预设为底，用户手写的自定义映射（不等于任何预设）覆盖其上；
//   2) freeAfterEvery 未显式配置时按模式取默认（AMD=3 定期释放显存，NVIDIA=0 关闭）。
// 一组 workflows 恰好等于某个硬件预设时返回该模式，否则 null（用于模式推断）。
function presetModeOf(wf) {
  if (!wf || typeof wf !== 'object') return null;
  for (const m of HW_MODES) {
    const keys = Object.keys(HW_PRESETS[m]);
    if (Object.keys(wf).length === keys.length && keys.every((k) => wf[k] === HW_PRESETS[m][k])) return m;
  }
  return null;
}

function resolveHardware(merged, raw) {
  // 显式 hardware.mode 优先；未显式配置时按 raw.workflows 匹配的预设推断模式 ——
  // 否则「整套 AMD 预设工作流」会被默认 nvidia 覆盖丢弃（实测踩坑），
  // 且 hardwareMode() 恒为 nvidia，令 AMD 专属保护（preflight 的 LLM/渲染不同批、CK、显存）全部失效。
  const explicit = HW_MODES.includes(raw?.hardware?.mode) ? raw.hardware.mode : null;
  const mode = explicit || presetModeOf(raw?.workflows) || (HW_MODES.includes(merged?.hardware?.mode) ? merged.hardware.mode : 'nvidia');
  merged.hardware = { ...merged.hardware, mode };

  const userWf = isPresetWorkflows(raw?.workflows) ? null : raw?.workflows;
  merged.workflows = { ...HW_PRESETS[mode], ...(userWf || {}) };

  if (raw?.generation?.freeAfterEvery == null) {
    // 兼容旧键 videoFreeAfterEvery（合并早期的配置）：写过就沿用其值，否则用模式默认值
    const legacy = raw?.generation?.videoFreeAfterEvery;
    merged.generation.freeAfterEvery = legacy != null ? Number(legacy) || 0 : HW_DEFAULT_FREE[mode];
  }
  delete merged.generation.videoFreeAfterEvery;
  return merged;
}

// 由「原始配置」（读来的 config.json，或前端 PUT 的配置）解析出实际生效配置。
// 纯函数：不读写磁盘，便于单测。
export function resolveHardwareConfig(raw) {
  return resolveHardware(deepMerge(structuredClone(DEFAULTS), raw || {}), raw || {});
}

export function loadConfig() {
  ensureDirs();
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  const merged = resolveHardwareConfig(raw);
  setDebug(!!merged.debug);
  return merged;
}

export function saveConfig(cfg) {
  ensureDirs();
  const merged = resolveHardwareConfig(cfg);
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
    path.join(base, 'references'),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  return base;
}
