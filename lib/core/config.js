import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDebug } from './logger.js';
import { HW_MODES, HW_PRESETS, HW_DEFAULT_FREE, hardwareMode, isPresetWorkflows, presetModeOf } from '../shared/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// lib/core/config.js -> lib/core -> lib -> 仓库根
export const ROOT = path.resolve(__dirname, '..', '..');
// 数据目录允许用 IC_DATA_DIR 覆盖：单测在临时目录里建库，避免污染真实 data/ic.db
export const DATA_DIR = process.env.IC_DATA_DIR ? path.resolve(process.env.IC_DATA_DIR) : path.join(ROOT, 'data');
// 媒体根目录可独立挂载：Docker 里把 IC_MEDIA_DIR 指到 volume（默认仍在 DATA_DIR/projects）。
export const MEDIA_DIR = process.env.IC_MEDIA_DIR ? path.resolve(process.env.IC_MEDIA_DIR) : path.join(DATA_DIR, 'projects');
export const PROJECTS_DIR = MEDIA_DIR;
export const DB_PATH = process.env.IC_DB_SQLITE_PATH
  ? path.resolve(process.env.IC_DB_SQLITE_PATH)
  : path.join(DATA_DIR, 'ic.db');
// 配置文件也允许挂载：Docker 里 IC_CONFIG=/data/config.json，避免写进镜像层。
export const CONFIG_PATH = process.env.IC_CONFIG ? path.resolve(process.env.IC_CONFIG) : path.join(ROOT, 'config.json');
export const WORKFLOWS_DIR = path.join(ROOT, 'workflows');
export const SKILLS_DIR = path.join(ROOT, 'skills');

// —— 硬件模式：一键切换「英伟达原版工作流」与「AMD + GGUF 适配工作流」 ——
// 常量与判定函数定义在 lib/shared（纯数据，设置页也直接引用同一份），这里只做转出与配置解析。
export { HW_MODES, HW_PRESETS, HW_DEFAULT_FREE, hardwareMode, presetModeOf, comfyBaseUrl, maskComfyBaseUrl } from '../shared/index.js';

const DEFAULTS = {
  debug: false,
  server: { port: 4600, host: '127.0.0.1' },
  // 数据库：sqlite = 免安装快速启动；postgres = 正式部署。
  // 可用 IC_DB / DATABASE_URL / IC_DB_SQLITE_PATH 覆盖，见 dbSettings()。
  db: {
    provider: 'sqlite',
    sqlite: { path: '' },
    postgres: { url: '', host: '127.0.0.1', port: 5432, user: 'postgres', password: '', database: 'infinite_creation', ssl: false },
  },
  comfyui: { provider: 'native', baseUrl: 'http://127.0.0.1:8188', apiKey: '', tier: 'standard' },
  llm: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'DeepSeek-V4.1-Flash', tools: true, vision: false, rewriteLanguage: 'same', rewriteMaxTokens: 4000 },
  hardware: { mode: 'nvidia' },
  // 并发数按 ComfyUI 单队列串行执行的实际吞吐定：视频单条 15-30 分钟，超时须覆盖排队时间。
  // freeAfterEvery = 「生成维护」每 N 个 ComfyUI 生成任务释放一次显存（0 = 关闭）。
  // 默认值由 hardware.mode 推导（HW_DEFAULT_FREE），loadConfig 里统一解析；旧键 videoFreeAfterEvery 在 loadConfig 时迁移。
  generation: {
    imageConcurrency: 2,
    videoConcurrency: 1,
    runninghubConcurrency: 1,
    // 同一进程同时运行的章节 Agent 数；超出的任务显示「等待 Agent 槽位」。
    // 每个章节 Agent 会长期占用一个槽位（包含渲染等待），按 LLM 限流和机器资源调。
    agentConcurrency: 4,
    agentQueueTimeoutMinutes: 120,
    retryTimes: 3,
    videoTimeoutMinutes: 90,
    imageTimeoutMinutes: 30,
    freeAfterEvery: 0,
    // —— 渲染队列（仅 RunningHub 云端模式生效；本地 ComfyUI 仍走整批串行，避免显存互相踩） ——
    // 所有值都可随时改，调度器每 tick 重新读配置，不需要重启。
    queue: {
      enabled: true,
      capacity: 0,                 // 全局槽位；0 = 跟随 runninghubConcurrency
      perUserConcurrency: 0,       // 单用户硬上限；0 = 不额外限制，按「容量 / 在线人数」动态分配
      perUserMaxWaiting: 50,       // 单用户最多排队数，超出直接拒绝，防止队列无限膨胀
      queueTimeoutMinutes: 120,    // 单条任务等待槽位上限
      agingMinutes: 15,            // 等待超过该时长自动提权，防止被插队饿死
      tickMs: 500,                 // 调度间隔
      leaseMinutes: 30,            // 执行租约：超时视为执行器失联，重新排队
      retryTimes: 2,               // 渲染失败自动重试次数（仅可重试错误）
      pauseOnQuotaErrorMinutes: 10, // 命中余额/并发超限类错误时暂停派发多久
      pools: {
        // min = 保底槽位（有积压时优先满足），max = 0 表示不单独限制（可借用全部空槽）
        image: { min: 1, max: 0 },
        video: { min: 1, max: 0 },
        tts: { min: 0, max: 0 },
        music: { min: 0, max: 0 },
      },
    },
  },
  // workflows 默认 = HW_PRESETS.nvidia；loadConfig 按 hardware.mode 推导，勿直接改这里
  workflows: HW_PRESETS.nvidia,
  // —— 账号与单点登录（父平台 iframe 嵌入时使用）——
  // 独立部署时保持 enabled=false，由管理员在后台建号；嵌入时填入父平台的 JWT 配置即可。
  auth: {
    enabled: null,               // null = 跟随启动脚本的 IC_AUTH；true/false = 后台/独立路由强制开关
    sso: {
      enabled: false,
      algorithm: 'HS256',        // HS256（共享密钥）或 RS256（公钥）
      secret: '',                // HS256 用
      publicKey: '',             // RS256 用（PEM 文本）
      issuer: '',                // 可选：校验 iss
      audience: '',              // 可选：校验 aud
      userIdClaim: 'sub',
      usernameClaim: 'username',
      roleClaim: 'role',
      permsClaim: 'perms',
      allowedOrigins: [],        // postMessage 来源白名单；留空不限制（JWT 仍验签）
      clockToleranceSec: 30,
    },
  },
  // —— 费用提醒与用量回传（嵌入计费时使用）——  // showCost 打开后，生成类按钮会显示按价目表估算的费用；价格由管理员后台配置。
  billing: {
    showCost: false,
    enforceBalance: false,       // 预留：提交前调用父平台余额校验
    chargeExport: false,         // 导出/合成是否计费（按 exportPerChapter）
    currency: '点',
    reportUrl: '',               // 预留：任务结束后回传用量的 webhook
    reportToken: '',             // 回传鉴权
    balanceUrl: '',              // 预留：提交前查余额的接口
    balanceToken: '',
    dailyLimit: 0,               // 每用户每日额度（0=不限制，单位同 currency）
    monthlyLimit: 0,             // 每用户每月额度（0=不限制）
    reportRetryTimes: 5,         // 用量回传失败重试次数
    // 上游（RunningHub）任务取消/失败时的计费策略：
    //   charge_if_started=已 RUNNING/失败/超时仍计费，排队中取消退回（默认，避免平台倒贴）
    //   always_refund=一律退回；always_charge=提交成功就计费
    providerCancelPolicy: 'charge_if_started',
    // 本地积分钱包：开启后每个计费步骤提交前先预扣（hold），成功转用量、失败退回。
    // 默认关闭，管理后台充值后手动开启，避免升级后 0 余额把所有人挡住。
    wallet: {
      enabled: false,
      requireFullEstimate: false, // true=整章预算不够就不允许开始；默认允许部分执行
      holdTtlMinutes: 2880,       // 预授权兜底有效期（48h），进程异常时到期自动退回
    },
    prices: {
      llmPerChapter: 0,          // LLM 创作（每章）
      llmRewritePerCall: 0,      // LLM 改写提示词（每次）
      imagePerAsset: 0,          // 资产图（每张）
      ttsPerVoice: 0,            // 音色（每个）
      videoPerSecond: 0,         // 分镜视频（每秒）
      musicPerTrack: 0,          // 背景音乐（每首）
      exportPerChapter: 0,       // 合成/导出（每章）
    },
  },
  // —— 界面功能开关（只控制是否显示，不改变权限/接口）——
  // 管理后台可逐项隐藏 Studio 的 Tab 与入口；隐藏后接口仍受角色/权限校验。
  features: {
    tabs: {
      workflow: true,
      chapters: true,
      assets: true,
      shots: true,
      music: true,
      exports: true,
      logs: true,
    },
    taskDrawer: true,      // 项目页「任务」按钮
    createProject: true,   // 「新建项目」入口
    settings: true,        // 「设置」入口（本来就只有管理员可见）
    // 素材分类可见性（同时作用于素材库筛选、新建资产、分镜素材选择）
    assetCategories: {
      character: true,
      scene: true,
      prop: true,
      costume: true,
      age: true,
      voice: true,
      music: true,
      sfx: true,
      other: true,
    },
    // 主要操作按钮显隐（只控制界面；权限校验不变）
    buttons: {
      generate: true,
      export: true,
      upload: true,
      delete: true,
      projectSettings: true,
      login: true,
      github: true,
    },
  },
  // —— 内容审核 ——
  // enabled 是总开关：null 时跟随 IC_MODERATION；关闭时文本与图片审核都会停用。
  // text.enabled 是文本分项（null=跟随总开关）；baidu.enabled 是图片分项。
  // 文本：本地词表只作线索，最终由 LLM 按整段语义判断。
  moderation: {
    enabled: null,
    text: {
      enabled: null,
    },
    failClosed: null,        // null=跟随 IC_MODERATION_FAIL_CLOSED；true=服务异常时拦截，false=放行
    baidu: {
      enabled: false,
      apiKey: '',                // 百度智能云应用 API Key
      secretKey: '',             // Secret Key
      strategyId: '',            // 可选：百度控制台自定义策略 ID
      failClosed: true,          // 审核服务异常时是否拦截替换（true = 宁可拒绝）
      endpoint: '',              // 可选：私有代理/联调地址；留空用百度官方接口
      tokenEndpoint: '',         // 可选：鉴权地址；留空用百度官方接口
    },
  },
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  try { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); } catch { /* 只读挂载时忽略 */ }
}

// 把 hardware.mode 解析成实际生效配置：
//   1) workflows 以对应模式预设为底，用户手写的自定义映射（不等于任何预设）覆盖其上；
//   2) freeAfterEvery 未显式配置时按模式取默认（AMD=3 定期释放显存，NVIDIA=0 关闭）。
// 一组 workflows 恰好等于某个硬件预设时返回该模式，否则 null（用于模式推断）；
// 判定实现见 lib/shared/index.js 的 presetModeOf/matchesPreset（允许缺后加的 music 键）。
function resolveHardware(merged, raw) {
  // 显式 hardware.mode 优先；未显式配置时按 raw.workflows 匹配的预设推断模式 ——
  // 否则「整套 AMD 预设工作流」会被默认 nvidia 覆盖丢弃（实测踩坑），
  // 且 hardwareMode() 恒为 nvidia，令 AMD 专属保护（preflight 的 CK 缺陷与显存余量判定）失效。
  // 注意：这里不再有任何「LLM 与 ComfyUI 能否同批/同时常驻」的判定——服务由用户手动启停，
  // 应用不根据服务状态决定行为（曾经基于 job-runner.bothLocal 的互斥拦截已删除）。
  const explicit = HW_MODES.includes(raw?.hardware?.mode) ? raw.hardware.mode : null;
  const mode = explicit || presetModeOf(raw?.workflows) || (HW_MODES.includes(merged?.hardware?.mode) ? merged.hardware.mode : 'nvidia');
  merged.hardware = { ...merged.hardware, mode };

  const userWf = isPresetWorkflows(raw?.workflows) ? null : raw?.workflows;
  merged.workflows = { ...HW_PRESETS[mode], ...(userWf || {}) };

  // 配置段被写成非对象（手改成 null / "x" / 5 / 数组）时，deepMerge 会原样保留该值，
  // 上游一取属性就抛：
  //   · generation：下面两行直接写 freeAfterEvery → TypeError，而 loadConfig 每个请求都跑
  //     → 全部路由 500、PUT /api/config 也 500；
  //   · comfyui / llm：`PUT /api/config` 回写后前端 `cfg.comfyui.provider` 抛 → 设置页整页白屏，
  //     服务端 `cfg.llm.baseUrl` 之类的读取同样会抛（只有部分调用点用了 ?.)；
  //   · server：`server.host` 被读来做启动/展示。
  // 脏配置只该退回默认值，不该让应用不可用 —— 这里对所有配置段做同一次兜底。
  for (const key of ['server', 'comfyui', 'llm', 'hardware', 'generation']) {
    const v = merged[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) merged[key] = { ...DEFAULTS[key] };
  }
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

// 数据库连接解析：环境变量优先于 config.json。DATABASE_URL 存在时自动选 postgres，
// 显式 IC_DB=sqlite 仍可强制回 SQLite（便于本地调试）。
export function dbSettings() {
  let raw = {};
  try { raw = loadConfig().db || {}; } catch { /* 配置读不到时用默认值 */ }
  const env = process.env;
  const requested = String(
    env.IC_DB
      ? env.IC_DB
      : (env.DATABASE_URL ? 'postgres' : (raw.provider || 'sqlite')),
  ).toLowerCase();
  const provider = requested === 'postgres' || requested === 'postgresql' || requested === 'pg' ? 'postgres' : 'sqlite';
  const sqlitePath = env.IC_DB_SQLITE_PATH
    ? path.resolve(env.IC_DB_SQLITE_PATH)
    : (raw.sqlite && raw.sqlite.path)
      ? path.resolve(ROOT, raw.sqlite.path)
      : DB_PATH;
  const p = raw.postgres || {};
  return {
    provider,
    sqlitePath,
    postgres: {
      url: env.DATABASE_URL || p.url || '',
      host: env.PGHOST || p.host || '127.0.0.1',
      port: Number(env.PGPORT || p.port || 5432),
      user: env.PGUSER || p.user || 'postgres',
      password: env.PGPASSWORD != null ? env.PGPASSWORD : (p.password || ''),
      database: env.PGDATABASE || p.database || 'infinite_creation',
      ssl: env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : (p.ssl || false),
    },
  };
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
