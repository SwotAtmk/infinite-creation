import { createDb } from './db-driver.js';
import { uid, now, safeJsonParse } from './utils.js';
import { recordChange, rawGet } from './changelog.js';
import { ASSET_CATEGORY_IDS, AUDIO_ASSET_CATEGORIES, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS, VIDEO_DIM_MIN, VIDEO_DIM_MAX, PROJECT_TYPES, isVariantAssetCategory } from '../shared/index.js';
import { logger } from './logger.js';
import { currentUser } from './context.js';
import { assertSafeSync } from './moderation.js';

let db;
export function getDb() {
  if (!db) {
    db = createDb();
    initSchema(db);
    try { logger.info('数据库驱动：' + (db.dialect === 'postgres' ? 'PostgreSQL' : 'SQLite')); } catch {}
  }
  return db;
}

// 建表 + 旧库迁移。SQLite / PostgreSQL 共用同一份 DDL：
// 驱动在 PostgreSQL 下把 INTEGER 放大成 BIGINT、REAL 放大成 DOUBLE PRECISION
// （毫秒时间戳 1.7e12 超出 PG INTEGER 范围）。
export function initSchema(db) {
  db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'agent',
        novel TEXT DEFAULT '',
        idea TEXT DEFAULT '',
        style TEXT DEFAULT '',
        video_resolution TEXT DEFAULT '480P',
        video_aspect_ratio TEXT DEFAULT '16:9',
        video_width INTEGER DEFAULT 0,
        video_height INTEGER DEFAULT 0,
        target_duration REAL DEFAULT 0,
        context TEXT DEFAULT '{}',
        status TEXT DEFAULT 'idle',
        enable_bgm INTEGER DEFAULT 1,
        enable_subtitles INTEGER DEFAULT 1,
        is_public INTEGER DEFAULT 1,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_id TEXT DEFAULT '',
        description TEXT DEFAULT '',
        voice_desc TEXT DEFAULT '',
        voice_desc_used TEXT DEFAULT '',
        prompt TEXT DEFAULT '',
        prompt_used TEXT DEFAULT '',
        prompt_locked INTEGER DEFAULT 0,
        lyrics TEXT DEFAULT '',
        max_duration REAL DEFAULT 0,
        negative_prompt TEXT DEFAULT '',
        voice_ref TEXT DEFAULT '',
        image_path TEXT DEFAULT '',
        audio_path TEXT DEFAULT '',
        video_path TEXT DEFAULT '',
        source TEXT DEFAULT 'none',
        consistency_key TEXT DEFAULT '',
        versions TEXT DEFAULT '[]',
        params TEXT DEFAULT '{}',
        status TEXT DEFAULT 'pending',
        error TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS shots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        chapter TEXT DEFAULT '',
        scene_name TEXT DEFAULT '',
        camera TEXT DEFAULT '',
        visual TEXT DEFAULT '',
        dialogue TEXT DEFAULT '',
        narration TEXT DEFAULT '',
        sub_shots TEXT DEFAULT '',
        prompt_id TEXT DEFAULT '',
        duration REAL DEFAULT 5,
        character_ids TEXT DEFAULT '[]',
        scene_ids TEXT DEFAULT '[]',
        prop_ids TEXT DEFAULT '[]',
        costume_ids TEXT DEFAULT '[]',
        age_ids TEXT DEFAULT '[]',
        audio_ids TEXT DEFAULT '[]',
        refs TEXT DEFAULT '[]',
        resolution TEXT DEFAULT '480P',
        aspect_ratio TEXT DEFAULT '16:9',
        mode TEXT DEFAULT '',
        video_prompt TEXT DEFAULT '',
        video_prompt_used TEXT DEFAULT '',
        video_path TEXT DEFAULT '',
        seed INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        error TEXT DEFAULT '',
        parent_shot_id TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT DEFAULT '',
        type TEXT DEFAULT 'create',
        status TEXT DEFAULT 'running',
        phase TEXT DEFAULT '',
        detail TEXT DEFAULT '',
        progress TEXT DEFAULT '{}',
        checkpoint TEXT DEFAULT '{}',
        log_path TEXT DEFAULT '',
        error TEXT DEFAULT '',
        started_at INTEGER,
        finished_at INTEGER,
        updated_at INTEGER
      );
      -- 渲染队列：每条 = 一次真正的 ComfyUI/RunningHub 生成（不是整条流水线）。
      -- 放在 DB 而不是内存里，是因为多入口（route 各自打包）与重启都要看到同一份队列；
      -- 调度器（lib/core/scheduler.js）只做「发牌」，执行仍在调用方的进程内完成。
      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        job_id TEXT DEFAULT '',
        project_id TEXT DEFAULT '',
        owner_id TEXT DEFAULT '',
        pool TEXT DEFAULT 'render',
        kind TEXT DEFAULT '',
        status TEXT DEFAULT 'waiting',
        priority INTEGER DEFAULT 0,
        seq INTEGER DEFAULT 0,
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        not_before INTEGER DEFAULT 0,
        lease_until INTEGER DEFAULT 0,
        worker_id TEXT DEFAULT '',
        remote_task_id TEXT DEFAULT '',
        dedupe_key TEXT DEFAULT '',
        payload TEXT DEFAULT '{}',
        last_error TEXT DEFAULT '',
        amount REAL DEFAULT 0,
        unit_price REAL DEFAULT 0,
        currency TEXT DEFAULT '',
        enqueued_at INTEGER,
        started_at INTEGER,
        finished_at INTEGER,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_queue_waiting ON queue_items(status, pool, seq);
      CREATE INDEX IF NOT EXISTS idx_queue_job ON queue_items(job_id);
      CREATE INDEX IF NOT EXISTS idx_queue_owner ON queue_items(owner_id, status);      -- 计费用量：每次真正完成的渲染记一条，用于后台查看与回传父平台扣费。
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        project_id TEXT DEFAULT '',
        owner_id TEXT DEFAULT '',
        job_id TEXT DEFAULT '',
        kind TEXT DEFAULT '',
        chapter TEXT DEFAULT '',
        subject TEXT DEFAULT '',
        hold_id TEXT DEFAULT '',
        note TEXT DEFAULT '',
        quantity REAL DEFAULT 0,
        unit_price REAL DEFAULT 0,
        amount REAL DEFAULT 0,
        currency TEXT DEFAULT '',
        reported INTEGER DEFAULT 0,
        report_error TEXT DEFAULT '',
        report_attempts INTEGER DEFAULT 0,
        next_retry_at INTEGER DEFAULT 0,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_usage_owner ON usage_events(owner_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_job ON usage_events(job_id);
      -- 本地积分钱包：平台独立记账，父平台只在 capture 时回传用量。
      CREATE TABLE IF NOT EXISTS wallets (
        owner_id TEXT PRIMARY KEY,
        balance REAL DEFAULT 0,
        currency TEXT DEFAULT '',
        updated_at INTEGER
      );
      -- 预授权：提交前先从 balance 扣掉；成功 capture 转用量，失败/取消 release 退回。
      CREATE TABLE IF NOT EXISTS wallet_holds (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        amount REAL DEFAULT 0,
        currency TEXT DEFAULT '',
        hold_key TEXT NOT NULL UNIQUE,
        job_id TEXT DEFAULT '',
        project_id TEXT DEFAULT '',
        kind TEXT DEFAULT '',
        chapter TEXT DEFAULT '',
        subject TEXT DEFAULT '',
        status TEXT DEFAULT 'held',
        usage_id TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER,
        expires_at INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_holds_owner ON wallet_holds(owner_id, status);
      CREATE INDEX IF NOT EXISTS idx_wallet_holds_job ON wallet_holds(job_id);
      CREATE TABLE IF NOT EXISTS wallet_ledger (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        type TEXT DEFAULT '',
        amount REAL DEFAULT 0,
        balance_after REAL DEFAULT 0,
        note TEXT DEFAULT '',
        ref_id TEXT DEFAULT '',
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_ledger_owner ON wallet_ledger(owner_id, created_at);
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        version TEXT DEFAULT '',
        source TEXT DEFAULT 'bundled',
        enabled INTEGER DEFAULT 1,
        path TEXT DEFAULT '',
        manifest TEXT DEFAULT '{}',
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT DEFAULT 'custom',
        source_file TEXT DEFAULT '',
        spec TEXT DEFAULT '{}',
        status TEXT DEFAULT 'active',
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        job_id TEXT DEFAULT '',
        seq INTEGER DEFAULT 0,
        role TEXT DEFAULT 'assistant',
        content TEXT DEFAULT '',
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT DEFAULT '',
        novel TEXT DEFAULT '',
        script TEXT DEFAULT '',
        seq INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        music_path TEXT DEFAULT '',
        music_prompt TEXT DEFAULT '',
        music_prompt_used TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS reference_images (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        chapter_id TEXT DEFAULT '',
        asset_id TEXT DEFAULT '',
        name TEXT DEFAULT '',
        image_path TEXT DEFAULT '',
        mode TEXT DEFAULT 'reference',
        category TEXT DEFAULT 'other',
        description TEXT DEFAULT '',
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS shot_videos (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        shot_id TEXT NOT NULL,
        idx INTEGER DEFAULT 0,
        video_path TEXT DEFAULT '',
        seed INTEGER DEFAULT 0,
        selected INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
      CREATE INDEX IF NOT EXISTS idx_shots_project ON shots(project_id);
      CREATE INDEX IF NOT EXISTS idx_shot_videos_shot ON shot_videos(shot_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
      CREATE INDEX IF NOT EXISTS idx_messages_job ON messages(job_id);
      -- 可回滚变更日志：内容表每次增删改留一份原始行快照（见 lib/core/changelog.js）。
      -- before / after 为 JSON 快照（null = 该侧不存在）；随项目删除而级联清空。
      CREATE TABLE IF NOT EXISTS change_logs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        batch_id TEXT DEFAULT '',
        ts INTEGER NOT NULL,
        source TEXT DEFAULT '',
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        before TEXT,
        after TEXT,
        revert_of TEXT DEFAULT '',
        reverted_by TEXT DEFAULT '',
        meta TEXT DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_change_logs_project ON change_logs(project_id, ts);
      CREATE INDEX IF NOT EXISTS idx_change_logs_batch ON change_logs(project_id, batch_id);
    `);
    // 迁移：为旧库补列（已存在则忽略，不丢用户数据）
    try { db.exec("ALTER TABLE shots ADD COLUMN chapter TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE assets ADD COLUMN video_path TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE assets ADD COLUMN parent_id TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE shots ADD COLUMN costume_ids TEXT DEFAULT '[]'"); } catch {}
    try { db.exec("ALTER TABLE shots ADD COLUMN age_ids TEXT DEFAULT '[]'"); } catch {}
    try { db.exec("ALTER TABLE shots ADD COLUMN audio_ids TEXT DEFAULT '[]'"); } catch {}
    try { db.exec("ALTER TABLE projects ADD COLUMN video_width INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE projects ADD COLUMN video_height INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE projects ADD COLUMN enable_bgm INTEGER DEFAULT 1"); } catch {}
    try { db.exec("ALTER TABLE projects ADD COLUMN enable_subtitles INTEGER DEFAULT 1"); } catch {}
    // 展示开关：归属管理员且 is_public=1 的项目才对访客/普通用户可见
    try { db.exec("ALTER TABLE projects ADD COLUMN is_public INTEGER DEFAULT 1"); } catch {}
    // 计费用量：回传失败重试的尝试次数与下次重试时间
    try { db.exec("ALTER TABLE usage_events ADD COLUMN report_attempts INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE usage_events ADD COLUMN next_retry_at INTEGER DEFAULT 0"); } catch {}
    // 计费可见性：每条用量带上章节/对象/预授权，方便按章、按项目汇总
    try { db.exec("ALTER TABLE usage_events ADD COLUMN chapter TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE usage_events ADD COLUMN subject TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE usage_events ADD COLUMN hold_id TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE usage_events ADD COLUMN note TEXT DEFAULT ''"); } catch {}
    // 队列额度预留：入队即占用额度，完成才转成用量，失败/取消自动释放
    try { db.exec("ALTER TABLE queue_items ADD COLUMN amount REAL DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE queue_items ADD COLUMN unit_price REAL DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE queue_items ADD COLUMN currency TEXT DEFAULT ''"); } catch {}
    // 同一素材/分镜的并发渲染去重：两个入口（流水线 + 手动点生成）同时提交时，
    // 只允许一个 waiting/running 的条目存在，避免重复渲染与重复扣费。
    try { db.exec("ALTER TABLE queue_items ADD COLUMN dedupe_key TEXT DEFAULT ''"); } catch {}
    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_dedupe ON queue_items(dedupe_key) WHERE dedupe_key <> '' AND status IN ('waiting','running')");
    } catch {}
    // 账号体系：项目归属用户；旧库补列后由首个管理员在 bootstrap 时认领
    try { db.exec("ALTER TABLE projects ADD COLUMN owner_id TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE assets ADD COLUMN prompt_used TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE assets ADD COLUMN voice_desc_used TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE assets ADD COLUMN lyrics TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE assets ADD COLUMN max_duration REAL DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE assets ADD COLUMN params TEXT DEFAULT '{}'"); } catch {}
    // 背景音乐字段：chapters 表补 music_path / music_prompt / music_prompt_used（幂等判断用）
    try { db.exec("ALTER TABLE chapters ADD COLUMN music_path TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE chapters ADD COLUMN music_prompt TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE chapters ADD COLUMN music_prompt_used TEXT DEFAULT ''"); } catch {}
    // 剧本层：小说 → 分镜之间的中间产物，由外部写入 API（harness）或人工写入，流水线不隐式消费
    try { db.exec("ALTER TABLE chapters ADD COLUMN script TEXT DEFAULT ''"); } catch {}
    // 用户在前端手动保存过的提示词（prompt_locked=1）是权威：LLM 阶段的 update_asset 不得覆盖它。
    try { db.exec("ALTER TABLE assets ADD COLUMN prompt_locked INTEGER DEFAULT 0"); } catch {}
    // 回填：老库中已生成的资产假定「当前 prompt 就是当初用的」，避免升级后被判为改过而全量重生成
    try { db.exec("UPDATE assets SET prompt_used = prompt WHERE prompt_used = '' AND status = 'done' AND image_path <> ''"); } catch {}
    try { db.exec("UPDATE assets SET voice_desc_used = voice_desc WHERE voice_desc_used = '' AND voice_ref <> ''"); } catch {}
    try { db.exec("ALTER TABLE shots ADD COLUMN video_prompt_used TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE shots ADD COLUMN mode TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE projects ADD COLUMN type TEXT DEFAULT 'agent'"); } catch {}
    // 回填：已出过分镜视频的，假定「当前 video_prompt 就是当初用的」，避免升级后被判为改过而全量重渲染
    try { db.exec("UPDATE shots SET video_prompt_used = video_prompt WHERE video_prompt_used = '' AND status = 'done' AND video_path <> ''"); } catch {}
    // 迁移：多章节结构 —— 为每个项目补齐「第1章」，把旧 novel 迁过去并归类已有分镜
    try {
      db.exec("CREATE TABLE IF NOT EXISTS chapters (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT DEFAULT '', novel TEXT DEFAULT '', script TEXT DEFAULT '', seq INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', created_at INTEGER, updated_at INTEGER)");
      const projs = db.prepare('SELECT id, novel FROM projects').all();
      for (const p of projs) {
        const cnt = db.prepare('SELECT COUNT(*) AS c FROM chapters WHERE project_id=?').get(p.id).c;
        if (!cnt) {
          const t = now();
          db.prepare('INSERT INTO chapters (id,project_id,title,novel,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(uid(), p.id, '第1章', p.novel || '', 1, 'pending', t, t);
          db.prepare("UPDATE shots SET chapter='第1章' WHERE project_id=? AND (chapter IS NULL OR chapter='')").run(p.id);
          if (p.novel) db.prepare("UPDATE projects SET novel='' WHERE id=?").run(p.id);
        }
      }
    } catch (e) { /* 忽略迁移失败 */ }
// 迁移：老库 assets 表补 voice_desc 列（角色声音特征描述，音色设计/视频参考用）
    {
      const assetCols = db.tableColumns('assets');
      if (!assetCols.includes('voice_desc')) {
        try { db.exec("ALTER TABLE assets ADD COLUMN voice_desc TEXT DEFAULT ''"); } catch { /* 忽略失败 */ }
      }
      if (!assetCols.includes('error')) {
        try { db.exec("ALTER TABLE assets ADD COLUMN error TEXT DEFAULT ''"); } catch { /* 忽略失败 */ }
      }
    }
    // 迁移：参考素材不再区分项目级，把 chapter_id 为空的旧数据归入各项目「第1章」
    try {
      db.prepare("UPDATE reference_images SET chapter_id = (SELECT c.id FROM chapters c WHERE c.project_id = reference_images.project_id ORDER BY c.seq ASC LIMIT 1) WHERE chapter_id = ''").run();
    } catch (e) { /* 忽略迁移失败 */ }
    // 迁移：参考图支持「共享」（创建时拆成多章上传的参考图，所有章节共用）
    try { db.exec("ALTER TABLE reference_images ADD COLUMN shared INTEGER DEFAULT 0"); } catch { /* 忽略失败 */ }
    // 迁移：参考图来源 origin（uploaded=用户上传 / downloaded=Agent 联网下载），供「资产图」阶段兜底图生图。
    try { db.exec("ALTER TABLE reference_images ADD COLUMN origin TEXT DEFAULT 'uploaded'"); } catch { /* 忽略失败 */ }
}

// 事务：一次调用内的多条写入要么全成、要么全不成。
// node:sqlite 是同步 API，所以 fn 必须是**同步函数**（异步函数会在 COMMIT 之后才写库，
// 事务边界失效——这里用一次 then 检查把它变成显式报错，而不是悄悄错下去）。
// 嵌套调用复用外层事务（SQLite 不支持嵌套 BEGIN），所以级联删除里的递归 remove 可以各自包一层。
let txDepth = 0;
export function tx(fn) {
  const db = getDb();
  if (txDepth > 0) return fn();
  db.exec('BEGIN');
  txDepth++;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw Object.assign(new Error('tx() 只接受同步函数'), { code: 'ASYNC_TX' });
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始错误 */ }
    throw e;
  } finally {
    txDepth--;
  }
}

// 进程启动清理：把上次进程中断时仍卡在 running 的任务标记为 interrupted（中断≠失败，不写错误信息），
// 同时把 running 状态的项目复位为 idle，避免界面卡在「运行中」无法继续。
// 复位采用全量方式（而非只复位有 running job 的孤儿项目）：覆盖「job 已完成但 project.status 残留 running」的边界情况。
//
// 注意：这段逻辑绝不能放在 getDb() 里。getDb() 依赖模块级单例（let db）作为「只初始化一次」的标志，
// 但 Next.js 开发模式下 route handler 的模块会被独立编译、并在热更新时被重新加载，导致 let db 被重置、
// getDb() 重新执行 —— 若清理放在其中，会把「正在运行」的任务误标 interrupted、项目复位 idle，
// 前端刷新后就丢状态（按钮变回「生成/继续」），且 activeJobOf 防重失效，用户可重复提交产生并发任务、素材重复生成。
export function startupCleanup() {
  const db = getDb();
  const t = now();
  db.prepare("UPDATE jobs SET status='interrupted', error='', finished_at=? WHERE status='running'").run(t);
  db.prepare("UPDATE projects SET status='idle', updated_at=? WHERE status='running'").run(t);
  // 队列条目绑定的是当前进程内的执行器：进程没了就没人会来跑它。
  // 标 cancelled 而不是留在 waiting，否则界面永远显示「排队中」却不再前进。
  db.prepare("UPDATE queue_items SET status='cancelled', lease_until=0, last_error='服务重启，任务中断', finished_at=?, updated_at=? WHERE status IN ('waiting','running')").run(t, t);
  // 进程重启：所有仍然 held 的预授权都退回到余额（没有执行器会再来 capture 了）
  try { WalletHolds.releaseAllHeld('服务重启，预授权释放'); } catch { /* 忽略 */ }
  // 分镜卡在 generating：上次进程被强杀时没走到 catch 里的复位逻辑。
  // 有视频文件说明已下载完只差状态回写 → done；否则回到 pending，让「生成本镜」可用。
  db.prepare("UPDATE shots SET status = CASE WHEN video_path IS NOT NULL AND video_path <> '' THEN 'done' ELSE 'pending' END, error='' WHERE status='generating'").run();
  // 历史队列记录只留 7 天，避免表无限增长
  db.prepare("DELETE FROM queue_items WHERE status IN ('done','failed','cancelled') AND finished_at IS NOT NULL AND finished_at < ?").run(t - 7 * 24 * 3600 * 1000);
}

const toProject = (r) => ({ ...r, context: safeJsonParse(r.context, {}), enable_bgm: !!r.enable_bgm, enable_subtitles: !!r.enable_subtitles, is_public: r.is_public !== 0 });
const toAsset = (r) => ({ ...r, versions: safeJsonParse(r.versions, []), params: safeJsonParse(r.params, {}) });
const toShot = (r) => ({
  ...r,
  character_ids: safeJsonParse(r.character_ids, []),
  scene_ids: safeJsonParse(r.scene_ids, []),
  prop_ids: safeJsonParse(r.prop_ids, []),
  costume_ids: safeJsonParse(r.costume_ids, []),
  age_ids: safeJsonParse(r.age_ids, []),
  audio_ids: safeJsonParse(r.audio_ids, []),
  references: safeJsonParse(r.refs, []),
});
const toChapter = (r) => ({ ...r });
const toReference = (r) => ({ ...r });
const toJob = (r) => ({
  id: r.id, projectId: r.project_id, type: r.type, status: r.status, phase: r.phase, detail: r.detail,
  progress: safeJsonParse(r.progress, {}), checkpoint: safeJsonParse(r.checkpoint, {}),
  logPath: r.log_path, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at, updatedAt: r.updated_at,
});
const toSkill = (r) => ({ id: r.id, name: r.name, description: r.description, version: r.version, source: r.source, enabled: !!r.enabled, path: r.path, manifest: safeJsonParse(r.manifest, {}), createdAt: r.created_at, updatedAt: r.updated_at });
const toWorkflow = (r) => ({ id: r.id, name: r.name, kind: r.kind, sourceFile: r.source_file, spec: safeJsonParse(r.spec, {}), status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });

// 项目级视频参数是分镜的**回退上游**（生成时取 shot.resolution || project.video_resolution），
// 所以这里写错不是「一个字段难看」，而是整个项目的每一镜都在渲染阶段才炸（标签查不到映射表就被
// 原样写进 ComfyUI 参数）。界面下拉只给合法值，但 PATCH /api/projects/:id 与外部写入 API 能把任意
// 字符串塞进来，因此在 db 层校验：UI / 内置 Agent / 外部 harness 三条路径一并覆盖。
// 空值 = 用默认（'480P' / '16:9'），与 Shots.create 的默认值一致；未提供的键不校验（见 update）。
function projectEnums(fields) {
  const out = {};
  if (fields.video_resolution !== undefined) {
    const v = String(fields.video_resolution ?? '').trim() || '480P';
    if (!VIDEO_RESOLUTIONS.includes(v)) throw Object.assign(new Error('video_resolution 只能是 ' + VIDEO_RESOLUTIONS.join('/') + '（当前：' + v + '）'), { code: 'BAD_PROJECT_ENUM' });
    out.video_resolution = v;
  }
  if (fields.video_aspect_ratio !== undefined) {
    const v = String(fields.video_aspect_ratio ?? '').trim() || '16:9';
    if (!VIDEO_ASPECT_RATIOS.includes(v)) throw Object.assign(new Error('video_aspect_ratio 只能是 ' + VIDEO_ASPECT_RATIOS.join('/') + '（当前：' + v + '）'), { code: 'BAD_PROJECT_ENUM' });
    out.video_aspect_ratio = v;
  }
  return out;
}

// 自定义分辨率宽高（video_resolution=custom 时直接用作画布宽高）：0 = 未设置，非 0 必须落在
// [VIDEO_DIM_MIN, VIDEO_DIM_MAX]。与 projectEnums 同一口径——只在本次真正要写的键上校验，
// 存量行里的历史脏值不阻塞「改个名字」；也覆盖 POST /api/projects（它把 body 直通 create）。
function projectDims(fields) {
  const out = {};
  for (const k of ['video_width', 'video_height']) {
    if (fields[k] === undefined) continue;
    const n = Number(fields[k]);
    if (!Number.isFinite(n) || n < 0) {
      throw Object.assign(new Error(k + ' 必须是不小于 0 的数字（当前：' + fields[k] + '）'), { code: 'BAD_PROJECT_DIM' });
    }
    const px = Math.trunc(n);
    if (px !== 0 && (px < VIDEO_DIM_MIN || px > VIDEO_DIM_MAX)) {
      throw Object.assign(new Error(k + ' 必须在 ' + VIDEO_DIM_MIN + '~' + VIDEO_DIM_MAX + ' 像素之间（0 = 未设置、用默认分辨率）（当前：' + fields[k] + '）'), { code: 'BAD_PROJECT_DIM' });
    }
    out[k] = px;
  }
  return out;
}

// 项目类型校验：只在本次真正要写的 type 上校验；空值回退 'agent'（向后兼容老项目）。
function projectType(fields) {
  if (fields.type === undefined) return {};
  const v = String(fields.type ?? '').trim() || 'agent';
  if (!PROJECT_TYPES.includes(v)) throw Object.assign(new Error('type 只能是 ' + PROJECT_TYPES.join('/') + '（当前：' + v + '）'), { code: 'BAD_PROJECT_TYPE' });
  return { type: v };
}

// 展示项目：归属于管理员（未禁用）的项目对所有登录用户/访客只读可见。
// 写入权限仍由 server.js 统一拦截（非本人的管理员的项目一律 403），这里只放宽「读」。
// 缓存 5 秒：/files 下每个媒体请求都会走到 Projects.get，不能每次都查 users 表。
let adminOwnerCache = { at: 0, ids: new Set() };
function adminOwnerIds() {
  const t = Date.now();
  if (t - adminOwnerCache.at > 5000) {
    let ids = new Set();
    try {
      ids = new Set(getDb().prepare("SELECT id FROM users WHERE role='admin' AND disabled=0").all().map((r) => r.id));
    } catch {
      /* users 表还没建（未启用鉴权） */
    }
    adminOwnerCache = { at: t, ids };
  }
  return adminOwnerCache.ids;
}

export const Projects = {
  list() {
    const user = currentUser();
    if (user && user.role !== 'admin') {
      const admins = [...adminOwnerIds()];
      const sql = 'SELECT * FROM projects WHERE owner_id = ?'
        + (admins.length ? ' OR (owner_id IN (' + admins.map(() => '?').join(',') + ') AND is_public = 1)' : '')
        + ' ORDER BY updated_at DESC';
      return getDb().prepare(sql).all(user.id, ...admins).map(toProject);
    }
    return getDb().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map(toProject);
  },
  get(id) {
    const r = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!r) return null;
    const user = currentUser();
    // 非管理员：自己的项目 + 管理员「已公开」的展示项目
    if (user && user.role !== 'admin' && r.owner_id && r.owner_id !== user.id) {
      const isAdminOwner = adminOwnerIds().has(r.owner_id);
      if (!isAdminOwner || r.is_public === 0) return null;
    }
    return toProject(r);
  },
  isPublic(id) {
    const r = getDb().prepare('SELECT is_public FROM projects WHERE id = ?').get(id);
    return r ? r.is_public !== 0 : false;
  },
  // 原始归属查询：WS 广播等场景没有 ALS 上下文时使用
  ownerOf(id) {
    const r = getDb().prepare('SELECT owner_id FROM projects WHERE id = ?').get(id);
    return r ? r.owner_id || '' : null;
  },
  create({ name, type = 'agent', novel = '', idea = '', style = '', video_resolution = '480P', video_aspect_ratio = '16:9', video_width = 0, video_height = 0, target_duration = 0, enable_bgm = true, enable_subtitles = true, owner_id = '', chapters = null }) {
    const id = uid(); const t = now();
    const enums = projectEnums({ video_resolution, video_aspect_ratio });
    const dims = projectDims({ video_width, video_height });
    const typeInfo = projectType({ type });
    assertSafeSync({ name, novel, idea, style }, 'project.create');
    let owner = owner_id || currentUser()?.id || '';
    // 免登录/旧入口可能拿不到当前用户：归到第一个管理员，避免项目没人付费、估算余额为 0。
    if (!owner) {
      try {
        owner = getDb().prepare("SELECT id FROM users WHERE role='admin' AND disabled=0 ORDER BY created_at ASC LIMIT 1").get()?.id || '';
      } catch {
        /* users 表尚未创建 */
      }
    }
    // 拆成多章时，正文归属各章节，项目级 novel 置空（与既有迁移终态一致）
    const projectNovel = (Array.isArray(chapters) && chapters.length) ? '' : novel;
    getDb().prepare('INSERT INTO projects (id,name,type,novel,idea,style,video_resolution,video_aspect_ratio,video_width,video_height,target_duration,context,status,enable_bgm,enable_subtitles,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, typeInfo.type, projectNovel, idea, style, enums.video_resolution, enums.video_aspect_ratio, dims.video_width, dims.video_height, target_duration, '{}', 'idle', enable_bgm ? 1 : 0, enable_subtitles ? 1 : 0, owner, t, t);
    recordChange({ entity: 'project', action: 'create', after: rawGet('project', id) });
    // 章节：显式传入多章时逐章创建；否则回退到「第1章」承载整篇小说的既有行为
    const rows = (Array.isArray(chapters) && chapters.length)
      ? chapters
      : [{ title: '第1章', novel }];
    rows.forEach((ch, i) => {
      const chapterId = uid();
      const title = String(ch?.title || '').trim() || ('第' + (i + 1) + '章');
      getDb().prepare('INSERT INTO chapters (id,project_id,title,novel,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(chapterId, id, title, String(ch?.novel ?? ''), i + 1, 'pending', t, t);
      recordChange({ entity: 'chapter', action: 'create', after: rawGet('chapter', chapterId) });
    });
    return this.get(id);
  },
  update(id, fields) {
    const p = this.get(id); if (!p) return null;
    const before = rawGet('project', id);
    const m = { ...p, ...fields, updated_at: now() };
    // 只校验本次真正要写的这些字段：存量行里的历史值不该让「改个名字」也失败
    Object.assign(m, projectEnums(fields || {}), projectDims(fields || {}));
    assertSafeSync({ name: fields.name, novel: fields.novel, idea: fields.idea, style: fields.style }, 'project.update');
    getDb().prepare('UPDATE projects SET name=?, novel=?, idea=?, style=?, video_resolution=?, video_aspect_ratio=?, video_width=?, video_height=?, target_duration=?, context=?, status=?, enable_bgm=?, enable_subtitles=?, is_public=?, updated_at=? WHERE id=?')
      .run(m.name, m.novel ?? '', m.idea ?? '', m.style ?? '', m.video_resolution ?? '480P', m.video_aspect_ratio ?? '16:9', m.video_width ?? 0, m.video_height ?? 0, m.target_duration ?? 0, JSON.stringify(m.context ?? {}), m.status ?? 'idle', m.enable_bgm ? 1 : 0, m.enable_subtitles ? 1 : 0, m.is_public === false ? 0 : 1, m.updated_at, id);
    recordChange({ entity: 'project', action: 'update', before, after: rawGet('project', id) });
    return this.get(id);
  },
  // 只合并一个 context 键：多个章节的 Agent 同时写人物圣经/风格/连续性时，
  // 各自读到的 ctx 快照可能已经过期；整段写回会互相覆盖。这里在事务里重新读最新行再合并。
  setContextKey(id, key, value) {
    let out = null;
    tx(() => {
      const row = getDb().prepare('SELECT context FROM projects WHERE id = ?').get(id);
      if (!row) return;
      assertSafeSync({ [key]: value }, 'project.context');
      const before = rawGet('project', id);
      const ctx = safeJsonParse(row.context, {});
      ctx[key] = value;
      getDb().prepare('UPDATE projects SET context = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(ctx), now(), id);
      recordChange({ entity: 'project', action: 'update', before, after: rawGet('project', id) });
      out = ctx;
    });
    return out;
  },
  remove(id) {
    // 删项目要动 7 张表：包事务，避免中途失败留下「项目还在、章节/分镜已删」的残骸
    tx(() => {
      getDb().prepare('DELETE FROM assets WHERE project_id = ?').run(id);
      getDb().prepare('DELETE FROM shot_videos WHERE project_id = ?').run(id);
      getDb().prepare('DELETE FROM shots WHERE project_id = ?').run(id);
      getDb().prepare('DELETE FROM jobs WHERE project_id = ?').run(id);
      getDb().prepare('DELETE FROM messages WHERE project_id = ?').run(id);
      getDb().prepare('DELETE FROM chapters WHERE project_id = ?').run(id);
      getDb().prepare('DELETE FROM reference_images WHERE project_id = ?').run(id);
      // 变更日志随项目删除一并清除 —— 这是日志唯一的自动清理时机（用户手动删项目）
      getDb().prepare('DELETE FROM change_logs WHERE project_id = ?').run(id);
      getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
  },
};

export const Assets = {
  list(projectId, category) {
    if (category) return getDb().prepare('SELECT * FROM assets WHERE project_id = ? AND category = ? ORDER BY created_at ASC').all(projectId, category).map(toAsset);
    return getDb().prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at ASC').all(projectId).map(toAsset);
  },
  get(id) { const r = getDb().prepare('SELECT * FROM assets WHERE id = ?').get(id); return r ? toAsset(r) : null; },
  create(projectId, { category = 'other', name, description = '', parent_id = '', voice_desc = '', prompt = '', negative_prompt = '', prompt_locked = 0 }) {
    const id = uid(); const t = now();
    // 分类必须在值域内：素材库按 category 过滤（GET /assets?category=…、界面分组），
    // 写进一个不存在的分类，就等于造出一条「界面里看不见、批量生成/统计也扫不到」的行。
    // 值域来自 lib/shared 的单一事实来源（与界面下拉、Agent 工具 schema 共用一份）。
    if (!ASSET_CATEGORY_IDS.includes(category)) {
      throw Object.assign(new Error('素材分类不存在：' + category + '（可选：' + ASSET_CATEGORY_IDS.join('/') + '）'), { code: 'BAD_ASSET_CATEGORY' });
    }
    // 服装/年龄是「挂在角色下的变体」：只有 parent_id 指向角色才有意义 —— refs.js 只按
    // parent_id 把它们映射到角色（镜头里有该角色时才拿它替换角色参考图），tools.js 也只把
    // 「带 parent_id 的变体」算作该角色已有服装/年龄。允许建出无父变体 = 造一条素材库里
    // 看得见、分镜能引用、生成时却被静默忽略的行（还会被自动换装再生成一套）。
    if (isVariantAssetCategory(category) && !parent_id) {
      throw Object.assign(new Error('服装/年龄变体必须绑定角色（parent_id）'), { code: 'BAD_VARIANT_PARENT' });
    }
    // 反向同理：非变体分类不允许带 parent_id。parent_id 的唯一语义就是「挂在角色下的变体」，
    // 写在 character/scene/... 上只会让 Assets.remove 把它当子变体级联删掉、usageOf 把它计成
    // children（删除确认里冒出莫名其妙的「子变体」）——这里兜底抛错，而不是静默丢弃（静默丢弃
    // 会让调用方以为绑上了）。
    if (!isVariantAssetCategory(category) && parent_id) {
      throw Object.assign(new Error('parent_id 只用于服装（costume）/年龄（age）变体；' + category + ' 不能挂在其它素材下'), { code: 'BAD_ASSET_PARENT' });
    }
    // prompt 必须由 create 自己写库：调用方（换装/年龄变体）在 create 时就把提示词传进来了，
    // 早先这里漏收 prompt/negative_prompt，导致变体资产入库后提示词为空 —— 用户在素材库改提示词
    // 毫无作用（旧变体的 prompt 恒为 ''，重新生成时按「同名已存在」直接复用旧图）。
    assertSafeSync({ name, description, prompt, negative_prompt, voice_desc }, 'asset.create');
    getDb().prepare('INSERT INTO assets (id,project_id,category,name,parent_id,description,voice_desc,prompt,prompt_used,prompt_locked,negative_prompt,voice_ref,image_path,audio_path,video_path,source,consistency_key,versions,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, category, name, parent_id, description, voice_desc, prompt, '', prompt_locked ? 1 : 0, negative_prompt, '', '', '', '', 'none', '', '[]', 'pending', t, t);
    recordChange({ entity: 'asset', action: 'create', after: rawGet('asset', id) });
    return this.get(id);
  },
  update(id, fields) {
    const a = this.get(id); if (!a) return null;
    // 改分类同样必须在值域内（见 create 里的说明）：PATCH …/assets/:aid 把 category
    // 列在可编辑字段里，只在 create 挡一道，等于留了「先把行建出来、再改成脏分类」的后门。
    if (fields && fields.category !== undefined && !ASSET_CATEGORY_IDS.includes(fields.category)) {
      throw Object.assign(new Error('素材分类不存在：' + fields.category + '（可选：' + ASSET_CATEGORY_IDS.join('/') + '）'), { code: 'BAD_ASSET_CATEGORY' });
    }
    const before = rawGet('asset', id);
    const m = { ...a, ...fields, updated_at: now() };
    // 改分类**离开**变体分类（costume/age → 其它）时，parent_id 必须一并清掉：parent_id 只对变体有意义，
    // 留着它就会让这条「已经不是变体」的素材被 Assets.remove 当子变体级联删、被 usageOf 计成 children
    // （删角色时弹「有 N 个子变体一起被删」，里面却混着道具/场景）。与 create 的非变体守卫同一道不变量。
    if (fields && fields.category !== undefined && !isVariantAssetCategory(fields.category)) {
      m.parent_id = '';
    }
    // 同 create：改分类/parent_id 时不许把行留成「无父变体」。只在调用方**主动动这两列**时拦，
    // 这样修好之前已经落库的存量无父变体仍能改名/清理（守卫不误伤旧数据）。
    if (fields && (fields.category !== undefined || fields.parent_id !== undefined)
      && isVariantAssetCategory(fields.category === undefined ? a.category : fields.category)
      && !(fields.parent_id === undefined ? a.parent_id : fields.parent_id)) {
      throw Object.assign(new Error('服装/年龄变体必须绑定角色（parent_id）'), { code: 'BAD_VARIANT_PARENT' });
    }
    // 反向：把非变体改成「有父」同样要拦（create 有对应的守卫）。只判调用方**主动写 parent_id**
    // 的情况——存量行里若已有杂散 parent_id，不应连累「改个名字」这种无关编辑。
    if (fields && fields.parent_id !== undefined && String(fields.parent_id || '').trim()
      && !isVariantAssetCategory(fields.category === undefined ? a.category : fields.category)) {
      const cat = fields.category === undefined ? a.category : fields.category;
      throw Object.assign(new Error('parent_id 只用于服装（costume）/年龄（age）变体；' + cat + ' 不能挂在其它素材下'), { code: 'BAD_ASSET_PARENT' });
    }
    assertSafeSync({ name: fields.name, description: fields.description, prompt: fields.prompt, negative_prompt: fields.negative_prompt, voice_desc: fields.voice_desc, lyrics: fields.lyrics }, 'asset.update');
    getDb().prepare('UPDATE assets SET category=?, name=?, parent_id=?, description=?, voice_desc=?, voice_desc_used=?, prompt=?, prompt_used=?, prompt_locked=?, lyrics=?, max_duration=?, negative_prompt=?, voice_ref=?, image_path=?, audio_path=?, video_path=?, source=?, consistency_key=?, versions=?, params=?, status=?, error=?, updated_at=? WHERE id=?')
      .run(m.category, m.name, m.parent_id ?? '', m.description ?? '', m.voice_desc ?? '', m.voice_desc_used ?? '', m.prompt ?? '', m.prompt_used ?? '', m.prompt_locked ? 1 : 0, m.lyrics ?? '', m.max_duration ?? 0, m.negative_prompt ?? '', m.voice_ref ?? '', m.image_path ?? '', m.audio_path ?? '', m.video_path ?? '', m.source ?? 'none', m.consistency_key ?? '', JSON.stringify(m.versions ?? []), JSON.stringify(m.params ?? {}), m.status ?? 'pending', m.error ?? '', m.updated_at, id);
    recordChange({ entity: 'asset', action: 'update', before, after: rawGet('asset', id) });
    return this.get(id);
  },
  // 素材「正在被使用」的清单（切换用途/删除前先问一次）：
  //   children —— 挂在它下面的子变体（服装/年龄，parent_id 指向它；Assets.remove 会级联删掉）；
  //   shotIds  —— 引用它的分镜（character_ids/scene_ids/prop_ids/costume_ids/age_ids/audio_ids/refs）。
  // 为什么需要：把素材库里的素材切成「参考」用途时原实现直接删掉这条素材——如果它是角色，
  // 连服装/年龄变体一起没了；如果分镜正引用它，参考图会少一张、提示词里的
  // __MINIMAX_H3_REF_N__ 编号随之错位，而分镜数据本身看不出异常。
  usageOf(id) {
    const own = rawGet('asset', id);
    // 素材按项目隔离，只扫本项目分镜就够（不必全表扫）
    const projectId = own?.project_id || '';
    const children = getDb().prepare('SELECT id FROM assets WHERE parent_id = ?').all(id).length;
    const cols = ['character_ids', 'scene_ids', 'prop_ids', 'costume_ids', 'age_ids', 'audio_ids', 'refs'];
    const shotIds = [];
    for (const r of getDb().prepare('SELECT id, ' + cols.join(', ') + ' FROM shots WHERE project_id = ?').all(projectId)) {
      for (const c of cols) {
        const ids = safeJsonParse(r[c], []);
        if (Array.isArray(ids) && ids.some((x) => String(x) === String(id))) { shotIds.push(r.id); break; }
      }
    }
    return { children, shotIds };
  },
  remove(id, seen) {
    // 级联删子资产是递归多次写入：包事务（嵌套调用经 tx 深度判断直接内联），
    // 失败时不留「父删了、子还在」的悬空行，日志与数据也保持同一批次一致。
    return tx(() => {
      // 级联删除子资产（服装/年龄变体 parent_id 指向本角色），避免留下悬空的 parent_id。
      // seen 去重：parent_id 可经素材 PATCH 被改成自指/环形，否则这里的递归会栈溢出。
      const guard = seen || new Set();
      if (guard.has(id)) return;
      guard.add(id);
      for (const k of getDb().prepare('SELECT id FROM assets WHERE parent_id = ?').all(id)) Assets.remove(k.id, guard);
      const before = rawGet('asset', id);
      getDb().prepare('DELETE FROM assets WHERE id = ?').run(id);
      if (before) recordChange({ entity: 'asset', action: 'delete', before });
    });
  },
};

// 章节的分镜进度摘要：分镜状态机是 pending/generating/done/failed（lib/shared 的 SHOT_STATUS）。
// 这里判「生成中」必须认 generating —— 早先判的是 'running'，而分镜永远不会是 running，
// 于是正在出视频的章节一直被界面显示成「待生成」（历史上的 'running' 行仍然兼容）。
// genStatus 的取值域与界面标签表（app/pages/ChaptersView.jsx）一致：empty/pending/running/done/failed。
// tools.js 的 list_chapters / get_project 与 GET /api/projects/:id/chapters 共用这一份实现，避免再次漂移。
export function chapterStats(projectId, title) {
  const rows = getDb().prepare('SELECT status FROM shots WHERE project_id = ? AND chapter = ?').all(projectId, title);
  const done = rows.filter((r) => r.status === 'done').length;
  let gen = 'empty';
  if (rows.length) {
    if (done === rows.length) gen = 'done';
    else if (rows.some((r) => r.status === 'generating' || r.status === 'running')) gen = 'running';
    else if (rows.some((r) => r.status === 'failed')) gen = 'failed';
    else gen = 'pending';
  }
  return { total: rows.length, done, status: gen };
}

// 分镜的素材绑定数组 ↔ 该字段只允许哪一类素材（与界面 ShotsTab 的 MATERIAL_FIELD 一一对应）。
export const SHOT_REF_FIELD_CATEGORIES = {
  character_ids: ['character'],
  scene_ids: ['scene'],
  prop_ids: ['prop'],
  costume_ids: ['costume'],
  age_ids: ['age'],
  audio_ids: AUDIO_ASSET_CATEGORIES, // voice / music / sfx
};

// 归一化「本次要写入」的素材绑定数组：丢掉本项目里不存在、或分类与字段不符的 id。
// 这些 id 在生成时本来就会被静默忽略（refs.js 从本项目素材表里查不到它 → 参考图/音色少一份），
// 界面上也渲染不出来（找不到素材），但行里一直留着：外部写入方读回去以为绑上了，
// 界面每次保存又把整条数组写回来（ShotsTab 的 applyMaterial/removeMaterial 都是整条写），
// 于是它永远删不掉。删除素材就会造出这种悬空 id（shots 的绑定不随素材删除清理）。
//
// 只「丢弃 + 告警」而不是抛错：界面保存写的是整条数组，行里一旦有悬空 id（历史的、回滚回来的、
// 删素材造成的），严格拒绝会让那一镜之后再也绑不上任何素材——用户没有任何入口删掉那个 id。
// 只处理调用方**本次主动写**的字段，存量行的其它字段不受连累（同 parent_id 守卫的口径）。
function normalizeShotRefs(projectId, fields) {
  const out = {};
  const keys = Object.keys(SHOT_REF_FIELD_CATEGORIES).filter((k) => Array.isArray(fields?.[k]));
  if (!keys.length) return out;
  const cat = new Map(getDb().prepare('SELECT id, category FROM assets WHERE project_id = ?').all(projectId).map((r) => [r.id, r.category]));
  for (const k of keys) {
    const allow = SHOT_REF_FIELD_CATEGORIES[k];
    const kept = [];
    const dropped = [];
    for (const raw of fields[k]) {
      const id = String(raw ?? '');
      if (!id) continue;
      const c = cat.get(id);
      if (c && allow.includes(c)) kept.push(id);
      else dropped.push(id);
    }
    if (dropped.length) {
      logger.warn('分镜素材绑定丢弃了无效 id（字段 ' + k + '）：' + dropped.join('、')
        + ' —— 该素材不属于本项目，或分类与字段不符（' + k + ' 只接受 ' + allow.join('/') + '）');
    }
    out[k] = kept;
  }
  return out;
}

export const Shots = {
  list(projectId) { return getDb().prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY idx ASC').all(projectId).map(toShot); },
  // 按「叙事顺序」列出：先按所属章节的 seq，再按章内 idx。
  // Shots.list 只按 idx 排序——界面上按章分组展示，组内有序即可；但「合成整片」若直接拿全局 idx
  // 排序，多章项目会变成「第1章第1镜、第2章第1镜、第1章第2镜……」的交叉顺序（各章 idx 都从 1 起）。
  // 章节归属按标题匹配，所以取章节 seq 用「相关子查询取最小 seq」，不用 LEFT JOIN 整表：
  // 标题重复（历史库里可能有两章同名）时 JOIN 会让同一条分镜出现两行 —— 成片里同一镜播两遍。
  // 标题匹配不到章节的分镜（历史脏数据）排在最后，不丢。
  listInNarrativeOrder(projectId) {
    return getDb().prepare(
      'SELECT s.* FROM shots s WHERE s.project_id = ?'
      + ' ORDER BY COALESCE((SELECT MIN(c.seq) FROM chapters c WHERE c.project_id = s.project_id AND c.title = s.chapter), 999999) ASC, s.idx ASC',
    ).all(projectId).map(toShot);
  },
  get(id) { const r = getDb().prepare('SELECT * FROM shots WHERE id = ?').get(id); return r ? toShot(r) : null; },
  create(projectId, shot = {}) {
    const id = uid(); const t = now();
    // 自动镜号按**章内**取号：idx 是「每章独立的镜号空间」（tools.js set_storyboard 同约定，
    // assemble_video 先按 chapter 过滤再按 idx 排序）。用项目级 MAX(idx) 会让同一章出现
    // 1,2,3,6 这种不连续编号，与「idx 连续」的自检口径打架。
    const max = getDb().prepare('SELECT MAX(idx) AS m FROM shots WHERE project_id = ? AND chapter = ?').get(projectId, shot.chapter ?? '')?.m ?? 0;
    const idx = shot.idx != null ? shot.idx : max + 1;
    const norm = normalizeShotRefs(projectId, shot);
    const arrOf = (k) => (norm[k] !== undefined ? norm[k] : (Array.isArray(shot[k]) ? shot[k].filter(Boolean) : []));
    const character_ids = arrOf('character_ids');
    const scene_ids = arrOf('scene_ids');
    const prop_ids = arrOf('prop_ids');
    const costume_ids = arrOf('costume_ids');
    const age_ids = arrOf('age_ids');
    const audio_ids = arrOf('audio_ids');
    assertSafeSync({ scene_name: shot.scene_name, camera: shot.camera, visual: shot.visual, dialogue: shot.dialogue, narration: shot.narration, sub_shots: shot.sub_shots, video_prompt: shot.video_prompt }, 'shot.create');
    getDb().prepare('INSERT INTO shots (id,project_id,idx,chapter,scene_name,camera,visual,dialogue,narration,sub_shots,prompt_id,duration,character_ids,scene_ids,prop_ids,costume_ids,age_ids,audio_ids,refs,resolution,aspect_ratio,mode,video_prompt,video_path,seed,status,error,parent_shot_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, idx, shot.chapter ?? '', shot.scene_name ?? '', shot.camera ?? '', shot.visual ?? '', shot.dialogue ?? '', shot.narration ?? '', shot.sub_shots ?? '', shot.prompt_id ?? '',
        shot.duration ?? 5, JSON.stringify(character_ids), JSON.stringify(scene_ids), JSON.stringify(prop_ids), JSON.stringify(costume_ids), JSON.stringify(age_ids), JSON.stringify(audio_ids), JSON.stringify(shot.references ?? []),
        shot.resolution ?? '480P', shot.aspect_ratio ?? '16:9', shot.mode ?? '', shot.video_prompt ?? '', shot.video_path ?? '', shot.seed ?? 0, shot.status ?? 'pending', '', shot.parent_shot_id ?? '', t, t);
    recordChange({ entity: 'shot', action: 'create', after: rawGet('shot', id) });
    return this.get(id);
  },
  update(id, fields) {
    const s = this.get(id); if (!s) return null;
    const before = rawGet('shot', id);
    const m = { ...s, ...fields, updated_at: now() };
    const norm = normalizeShotRefs(s.project_id, fields);
    const arrOf = (k) => (norm[k] !== undefined ? norm[k] : (Array.isArray(fields[k]) ? fields[k].filter(Boolean) : (s[k] || [])));
    const character_ids = arrOf('character_ids');
    const scene_ids = arrOf('scene_ids');
    const prop_ids = arrOf('prop_ids');
    const costume_ids = arrOf('costume_ids');
    const age_ids = arrOf('age_ids');
    const audio_ids = arrOf('audio_ids');
    const references = Array.isArray(fields.references) ? fields.references : (s.references || []);
    assertSafeSync({ scene_name: fields.scene_name, camera: fields.camera, visual: fields.visual, dialogue: fields.dialogue, narration: fields.narration, sub_shots: fields.sub_shots, video_prompt: fields.video_prompt }, 'shot.update');
    getDb().prepare('UPDATE shots SET idx=?, chapter=?, scene_name=?, camera=?, visual=?, dialogue=?, narration=?, sub_shots=?, prompt_id=?, duration=?, character_ids=?, scene_ids=?, prop_ids=?, costume_ids=?, age_ids=?, audio_ids=?, refs=?, resolution=?, aspect_ratio=?, mode=?, video_prompt=?, video_prompt_used=?, video_path=?, seed=?, status=?, error=?, parent_shot_id=?, updated_at=? WHERE id=?')
      .run(m.idx, m.chapter ?? '', m.scene_name ?? '', m.camera ?? '', m.visual ?? '', m.dialogue ?? '', m.narration ?? '', m.sub_shots ?? '', m.prompt_id ?? '',
        m.duration ?? 5, JSON.stringify(character_ids), JSON.stringify(scene_ids), JSON.stringify(prop_ids), JSON.stringify(costume_ids), JSON.stringify(age_ids), JSON.stringify(audio_ids), JSON.stringify(references),
        m.resolution ?? '480P', m.aspect_ratio ?? '16:9', m.mode ?? '', m.video_prompt ?? '', m.video_prompt_used ?? '', m.video_path ?? '', m.seed ?? 0, m.status ?? 'pending', m.error ?? '', m.parent_shot_id ?? '', m.updated_at, id);
    recordChange({ entity: 'shot', action: 'update', before, after: rawGet('shot', id) });
    return this.get(id);
  },
  remove(id) {
    const before = rawGet('shot', id);
    getDb().prepare('DELETE FROM shot_videos WHERE shot_id = ?').run(id);
    getDb().prepare('DELETE FROM shots WHERE id = ?').run(id);
    if (before) recordChange({ entity: 'shot', action: 'delete', before });
  },
};

// —— 单分镜多候选视频（一镜生成 N 条，用户单选一条优质候选用于导出成片）——
// 这是**渲染产物**表（与 shots.video_path / shots.seed 同语义），不接入 changelog：
// 候选的增删改只在 generateShotVideo / 选择路由里发生，若进内容日志会把日志与漂移检测淹掉。
// shots.video_path 永远指向「当前选中的候选路径」，因此导出/合成/打包/封面等已有链路零改动。
const toShotVideo = (r) => ({ ...r, selected: !!r.selected });

export const ShotVideos = {
  listByShot(shotId) { return getDb().prepare('SELECT * FROM shot_videos WHERE shot_id = ? ORDER BY idx ASC').all(shotId).map(toShotVideo); },
  get(id) { const r = getDb().prepare('SELECT * FROM shot_videos WHERE id = ?').get(id); return r ? toShotVideo(r) : null; },
  create(projectId, shotId, { idx = 0, video_path = '', seed = 0 } = {}) {
    const id = uid(); const t = now();
    getDb().prepare('INSERT INTO shot_videos (id,project_id,shot_id,idx,video_path,seed,selected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, shotId, idx, video_path, seed, 0, t, t);
    return this.get(id);
  },
  deleteByShot(shotId) { getDb().prepare('DELETE FROM shot_videos WHERE shot_id = ?').run(shotId); },
  deleteByProject(projectId) { getDb().prepare('DELETE FROM shot_videos WHERE project_id = ?').run(projectId); },
  setSelected(shotId, videoId) {
    getDb().prepare('UPDATE shot_videos SET selected = 0 WHERE shot_id = ?').run(shotId);
    getDb().prepare('UPDATE shot_videos SET selected = 1 WHERE id = ? AND shot_id = ?').run(videoId, shotId);
  },
  selectedForShot(shotId) {
    const r = getDb().prepare('SELECT * FROM shot_videos WHERE shot_id = ? AND selected = 1 ORDER BY idx ASC LIMIT 1').get(shotId)
      || getDb().prepare('SELECT * FROM shot_videos WHERE shot_id = ? ORDER BY idx ASC LIMIT 1').get(shotId);
    return r ? toShotVideo(r) : null;
  },
};

// 同项目内章节标题必须唯一：shots.chapter 存的是**标题**（不是 id），两章同名会让它们共用
// 同一批分镜——计数重复、删一章连带删掉另一章的镜头、渲染/合片混章。标题是业务键，所以挡在
// 最底层，UI / 内置 Agent / 外部 API 三条写入路径一并覆盖。
// 比较用 trim 后的值：'第1章' 与 '第1章 ' 在界面上无法区分，不允许并存。
function assertChapterTitleFree(projectId, title, excludeId = '') {
  const t = String(title ?? '').trim();
  if (!t) return;
  const dup = getDb().prepare('SELECT id, title FROM chapters WHERE project_id = ? AND id <> ?').all(projectId, excludeId)
    .find((c) => String(c.title ?? '').trim() === t);
  if (dup) {
    throw Object.assign(new Error('章节标题已存在：「' + t + '」。同项目内标题必须唯一——分镜按标题归属，重名会让两章共用同一批分镜。'), { code: 'DUP_CHAPTER_TITLE' });
  }
}

// 自动章节标题（「＋新增章节」固定发空标题）必须避开已有标题：标题是业务键且同项目唯一，
// 而 seq 只看现有最大序号 —— 用户把某章改名成「第3章」后（maxSeq 仍是 2），直接拼
// '第' + seq + '章' 会撞上唯一性校验，界面上「＋新增章节」只回一个 400、又没有填标题的入口，
// 等于建不了章。这里往后找到第一个没被占用的「第N章」。
function autoChapterTitle(projectId, seq) {
  const taken = new Set(getDb().prepare('SELECT title FROM chapters WHERE project_id = ?').all(projectId)
    .map((c) => String(c.title ?? '').trim()));
  let n = Math.max(1, Number(seq) || 1);
  while (taken.has('第' + n + '章')) n++;
  return '第' + n + '章';
}

export const Chapters = {
  list(projectId) { return getDb().prepare('SELECT * FROM chapters WHERE project_id = ? ORDER BY seq ASC').all(projectId).map(toChapter); },
  get(id) { const r = getDb().prepare('SELECT * FROM chapters WHERE id = ?').get(id); return r ? toChapter(r) : null; },
  create(projectId, { title = '', novel = '', script = '' } = {}) {
    const id = uid(); const t = now();
    const maxSeq = getDb().prepare('SELECT MAX(seq) AS s FROM chapters WHERE project_id = ?').get(projectId)?.s ?? 0;
    const seq = maxSeq + 1;
    // 空白标题按「没给标题」处理：标题是业务键（分镜按 title 归属），落一个纯空白标题
    // 会造出界面上看不见名字的一章，而且 PATCH 侧本来就拒绝空标题——创建侧放行等于
    // 「建得出来、却再也存不下去」。显式传空的写入会被路由层 pickChapterFields 先拒掉。
    const title2 = String(title ?? '').trim() ? title : autoChapterTitle(projectId, seq);
    assertChapterTitleFree(projectId, title2);
    assertSafeSync({ title: title2, novel, script }, 'chapter.create');
    getDb().prepare('INSERT INTO chapters (id,project_id,title,novel,script,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, title2, novel, script, seq, 'pending', t, t);
    recordChange({ entity: 'chapter', action: 'create', after: rawGet('chapter', id) });
    return this.get(id);
  },
  update(id, fields) {
    const c = this.get(id); if (!c) return null;
    const before = rawGet('chapter', id);
    const m = { ...c, ...fields, updated_at: now() };
    // 标题是业务键（分镜按 title 归属）：非空是底线，空标题会让整章分镜从章节视图消失
    // （外部写入 API 的 pickChapterFields 已挡一次，这里是所有写入口的最后一道）
    if (fields && fields.title !== undefined && !String(m.title ?? '').trim()) {
      throw Object.assign(new Error('章节标题不能为空——分镜按标题归属'), { code: 'EMPTY_CHAPTER_TITLE' });
    }
    if (String(m.title ?? '').trim() !== String(c.title ?? '').trim()) assertChapterTitleFree(c.project_id, m.title, id);
    assertSafeSync({ title: fields.title, novel: fields.novel, script: fields.script }, 'chapter.update');
    getDb().prepare('UPDATE chapters SET title=?, novel=?, script=?, seq=?, status=?, music_path=?, music_prompt=?, music_prompt_used=?, updated_at=? WHERE id=?')
      .run(m.title ?? '', m.novel ?? '', m.script ?? '', m.seq ?? 0, m.status ?? 'pending', m.music_path ?? '', m.music_prompt ?? '', m.music_prompt_used ?? '', m.updated_at, id);
    recordChange({ entity: 'chapter', action: 'update', before, after: rawGet('chapter', id) });
    return this.get(id);
  },
  // 拖拽排序：按传入 id 的顺序重排 seq（1..N）。seq 是叙事顺序的唯一键
  // （合成整片按「章节 seq → 章内 idx」排序），因此这里要求传入的必须是本项目章节的
  // 完整集合：只给一部分时，没上榜的章节会保留旧 seq 与上榜章节撞号，ORDER BY seq
  // 的结果不再确定，直接影响成片顺序。校验失败抛 code=BAD_CHAPTER_ORDER，由路由翻 400。
  reorder(projectId, ids) {
    const all = this.list(projectId).map((c) => c.id);
    const known = new Set(all);
    const bad = (msg) => Object.assign(new Error(msg), { code: 'BAD_CHAPTER_ORDER' });
    if (!Array.isArray(ids) || !ids.length) throw bad('缺少 ids');
    if (ids.some((cid) => !known.has(cid))) throw bad('章节不存在');
    if (new Set(ids).size !== ids.length) throw bad('ids 含重复章节');
    if (ids.length !== all.length) throw bad('排序需要包含全部章节（' + all.length + ' 个）');
    // 整批一个事务：中途失败不会留下「一半新 seq、一半旧 seq」的错乱顺序
    return tx(() => {
      ids.forEach((cid, i) => this.update(cid, { seq: i + 1 }));
      return { ok: true, count: ids.length };
    });
  },
  remove(id) {
    const c = this.get(id); if (!c) return null;
    // 删章节 + 级联分镜是多次写入，包一个事务：失败时不留「章节没了、分镜还在」的半吊子状态
    return tx(() => {
      // 级联删除的分镜也要逐条留档，否则回滚章节删除时找不回这些分镜
      const shots = getDb().prepare('SELECT * FROM shots WHERE project_id = ? AND chapter = ?').all(c.project_id, c.title);
      const before = rawGet('chapter', id);
      getDb().prepare('DELETE FROM shot_videos WHERE shot_id IN (SELECT id FROM shots WHERE project_id = ? AND chapter = ?)').run(c.project_id, c.title);
      getDb().prepare('DELETE FROM shots WHERE project_id = ? AND chapter = ?').run(c.project_id, c.title);
      getDb().prepare('DELETE FROM chapters WHERE id = ?').run(id);
      for (const s of shots) recordChange({ entity: 'shot', action: 'delete', before: s, meta: { cascade: 'chapter-delete' } });
      recordChange({ entity: 'chapter', action: 'delete', before, meta: { shots: shots.map((s) => s.id) } });
      return true;
    });
  },
};

export const ReferenceImages = {
  list(projectId, { chapterId = null, mode = null } = {}) {
    let sql = 'SELECT * FROM reference_images WHERE project_id = ?';
    const args = [projectId];
    if (chapterId) { sql += ' AND chapter_id = ?'; args.push(chapterId); }
    if (mode) { sql += ' AND mode = ?'; args.push(mode); }
    sql += ' ORDER BY created_at ASC';
    return getDb().prepare(sql).all(...args).map(toReference);
  },
  get(id) { const r = getDb().prepare('SELECT * FROM reference_images WHERE id = ?').get(id); return r ? toReference(r) : null; },
  create(projectId, { chapter_id = '', asset_id = '', name = '', image_path = '', mode = 'reference', category = 'other', description = '', shared = 0, origin = 'uploaded' }) {
    const id = uid(); const t = now();
    getDb().prepare('INSERT INTO reference_images (id,project_id,chapter_id,asset_id,name,image_path,mode,category,description,shared,origin,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, chapter_id, asset_id, name, image_path, mode, category, description, shared ? 1 : 0, origin || 'uploaded', t);
    recordChange({ entity: 'reference', action: 'create', after: rawGet('reference', id) });
    return this.get(id);
  },
  update(id, fields) {
    const a = this.get(id); if (!a) return null;
    const before = rawGet('reference', id);
    const m = { ...a, ...fields };
    getDb().prepare('UPDATE reference_images SET chapter_id=?, asset_id=?, name=?, image_path=?, mode=?, category=?, description=?, origin=? WHERE id=?')
      .run(m.chapter_id ?? '', m.asset_id ?? '', m.name ?? '', m.image_path ?? '', m.mode ?? 'reference', m.category ?? 'other', m.description ?? '', m.origin ?? 'uploaded', id);
    recordChange({ entity: 'reference', action: 'update', before, after: rawGet('reference', id) });
    return this.get(id);
  },
  remove(id) {
    const before = rawGet('reference', id);
    getDb().prepare('DELETE FROM reference_images WHERE id = ?').run(id);
    if (before) recordChange({ entity: 'reference', action: 'delete', before });
  },
};

export const Jobs = {
  create({ projectId = '', type = 'create', checkpoint = {} }) {
    const id = uid(); const t = now();
    getDb().prepare('INSERT INTO jobs (id,project_id,type,status,phase,detail,progress,checkpoint,log_path,error,started_at,finished_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, type, 'running', '准备', '', '{}', JSON.stringify(checkpoint ?? {}), '', '', t, null, t);
    return this.get(id);
  },
  update(id, fields) {
    const j = this.get(id); if (!j) return null;
    // 忽略 undefined：调用方常用 `x || undefined` 的写法，undefined 应表示「这一项不改」，
    // 否则 { ...旧, ...新 } 会把已有值（如 detail/phase）抹成空串。见 job-runner 的运行器。
    const clean = {};
    for (const [k, v] of Object.entries(fields || {})) if (v !== undefined) clean[k] = v;
    const m = { ...j, ...clean, updatedAt: now() };
    getDb().prepare('UPDATE jobs SET project_id=?, type=?, status=?, phase=?, detail=?, progress=?, checkpoint=?, log_path=?, error=?, started_at=?, finished_at=?, updated_at=? WHERE id=?')
      .run(m.projectId ?? '', m.type ?? 'create', m.status ?? 'running', m.phase ?? '', m.detail ?? '', JSON.stringify(m.progress ?? {}), JSON.stringify(m.checkpoint ?? {}), m.logPath ?? '', m.error ?? '', m.startedAt ?? null, m.finishedAt ?? null, m.updatedAt, id);
    return this.get(id);
  },
  get(id) { const r = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id); return r ? toJob(r) : null; },
  list(projectId) {
    if (projectId) return getDb().prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY started_at DESC').all(projectId).map(toJob);
    return getDb().prepare('SELECT * FROM jobs ORDER BY started_at DESC').all().map(toJob);
  },
  remove(id) { getDb().prepare('DELETE FROM jobs WHERE id = ?').run(id); },
};

// —— 渲染队列持久化 ——
// 状态机：waiting → running → done | failed | cancelled；failed 且允许重试时回到 waiting（not_before 控制退避）。
// 调度策略不在这里（见 lib/core/scheduler.js），这里只保证并发安全与字段一致。
const toQueueItem = (r) => ({
  id: r.id,
  jobId: r.job_id,
  projectId: r.project_id,
  ownerId: r.owner_id,
  pool: r.pool,
  kind: r.kind,
  status: r.status,
  priority: r.priority,
  seq: r.seq,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  notBefore: r.not_before,
  leaseUntil: r.lease_until,
  workerId: r.worker_id,
  remoteTaskId: r.remote_task_id,
  dedupeKey: r.dedupe_key || '',
  payload: safeJsonParse(r.payload, {}),
  lastError: r.last_error,
  amount: r.amount || 0,
  unitPrice: r.unit_price || 0,
  currency: r.currency || '',
  enqueuedAt: r.enqueued_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  updatedAt: r.updated_at,
});

export const Queue = {
  enqueue({
    jobId = '', projectId = '', ownerId = '', pool = 'render', kind = '',
    priority = 0, payload = {}, maxAttempts = 3, notBefore = 0, workerId = '',
    amount = 0, unitPrice = 0, currency = '', dedupeKey = '',
  }) {
    const id = uid();
    const t = now();
    const key = String(dedupeKey || '').slice(0, 200);
    const duplicate = () => {
      const active = key
        ? getDb().prepare("SELECT * FROM queue_items WHERE dedupe_key=? AND status IN ('waiting','running')").get(key)
        : null;
      const e = new Error('同一素材/分镜已有渲染任务在排队或执行');
      e.code = 'DUPLICATE_RENDER';
      e.existing = active ? toQueueItem(active) : null;
      return e;
    };
    // 先查一次给出可读错误；靠上面的唯一索引兜住多进程并发（查与插之间仍可能被抢先）
    if (key && getDb().prepare("SELECT 1 FROM queue_items WHERE dedupe_key=? AND status IN ('waiting','running')").get(key)) {
      throw duplicate();
    }
    const seq = (getDb().prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM queue_items').get().n) || 1;
    try {
      getDb().prepare(
        'INSERT INTO queue_items (id,job_id,project_id,owner_id,pool,kind,status,priority,seq,attempts,max_attempts,not_before,lease_until,worker_id,remote_task_id,dedupe_key,payload,last_error,amount,unit_price,currency,enqueued_at,started_at,finished_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id, jobId, projectId, ownerId, pool, kind, 'waiting', priority, seq,
        0, Math.max(1, maxAttempts), notBefore, 0, String(workerId || ''), '', key, JSON.stringify(payload ?? {}), '',
        Number(amount) || 0, Number(unitPrice) || 0, String(currency || ''),
        t, null, null, t,
      );
    } catch (e) {
      if (/UNIQUE constraint failed: queue_items\.dedupe_key|idx_queue_dedupe|queue_items_dedupe_key/i.test(String(e && e.message))) throw duplicate();
      throw e;
    }
    return this.get(id);
  },
  get(id) {
    const r = getDb().prepare('SELECT * FROM queue_items WHERE id = ?').get(id);
    return r ? toQueueItem(r) : null;
  },
  // 查询某个素材/分镜是否已有排队/执行中的渲染（用于手动入口提前返回 409）
  activeByDedupe(dedupeKey) {
    const key = String(dedupeKey || '');
    if (!key) return null;
    const r = getDb().prepare("SELECT * FROM queue_items WHERE dedupe_key=? AND status IN ('waiting','running') ORDER BY seq LIMIT 1").get(key);
    return r ? toQueueItem(r) : null;
  },
  // 领取槽位：只有仍是 waiting 的条目能被领走（多入口/多实例下也不会重复派发）
  claim(id, leaseMs) {
    const t = now();
    const r = getDb().prepare(
      "UPDATE queue_items SET status='running', started_at=COALESCE(started_at, ?), lease_until=?, attempts=attempts+1, updated_at=? WHERE id=? AND status='waiting'",
    ).run(t, t + Math.max(1000, leaseMs || 0), t, id);
    return (r.changes || 0) > 0;
  },
  finish(id) {
    const t = now();
    getDb().prepare("UPDATE queue_items SET status='done', lease_until=0, finished_at=?, updated_at=? WHERE id=?")
      .run(t, t, id);
  },
  // 失败/取消。cancelled=true 单独记状态，避免「用户停止」在队列里显示成失败。
  fail(id, error = '', { cancelled = false, retryAt = 0 } = {}) {
    const t = now();
    if (retryAt && !cancelled) {
      getDb().prepare("UPDATE queue_items SET status='waiting', not_before=?, lease_until=0, last_error=?, updated_at=? WHERE id=?")
        .run(retryAt, String(error).slice(0, 500), t, id);
      return;
    }
    getDb().prepare("UPDATE queue_items SET status=?, lease_until=0, last_error=?, finished_at=?, updated_at=? WHERE id=?")
      .run(cancelled ? 'cancelled' : 'failed', String(error).slice(0, 500), t, t, id);
  },
  cancel(id, reason = '已取消') {
    this.fail(id, reason, { cancelled: true });
  },
  // 立即摘除某个 job 的等待条目（停止按钮：不必等它轮到自己）
  cancelWaitingByJob(jobId) {
    if (!jobId) return [];
    const rows = getDb().prepare("SELECT * FROM queue_items WHERE job_id=? AND status='waiting'").all(jobId).map(toQueueItem);
    const t = now();
    getDb().prepare("UPDATE queue_items SET status='cancelled', last_error='任务已停止（排队中）', finished_at=?, updated_at=? WHERE job_id=? AND status='waiting'")
      .run(t, t, jobId);
    return rows;
  },
  cancelByJob(jobId) {
    if (!jobId) return 0;
    const t = now();
    const r = getDb().prepare("UPDATE queue_items SET status='cancelled', lease_until=0, last_error='任务已停止', finished_at=?, updated_at=? WHERE job_id=? AND status IN ('waiting','running')")
      .run(t, t, jobId);
    return r.changes || 0;
  },
  hasRunning(jobId) {
    if (!jobId) return false;
    return !!getDb().prepare("SELECT 1 AS x FROM queue_items WHERE job_id=? AND status='running' LIMIT 1").get(jobId);
  },
  // workerId 用于隔离「同时运行的多个后端进程」：各自只派发自己入队的条目，
  // 否则 4610 的调度器会把 4600 进程里等待的任务领走，却找不到对应的执行器。
  running(workerId = '') {
    if (workerId) return getDb().prepare("SELECT * FROM queue_items WHERE status='running' AND worker_id=? ORDER BY started_at ASC").all(workerId).map(toQueueItem);
    return getDb().prepare("SELECT * FROM queue_items WHERE status='running' ORDER BY started_at ASC").all().map(toQueueItem);
  },
  waiting(before = now(), workerId = '') {
    if (workerId) return getDb().prepare("SELECT * FROM queue_items WHERE status='waiting' AND not_before<=? AND worker_id=? ORDER BY priority DESC, seq ASC").all(before, workerId).map(toQueueItem);
    return getDb().prepare("SELECT * FROM queue_items WHERE status='waiting' AND not_before<=? ORDER BY priority DESC, seq ASC").all(before).map(toQueueItem);
  },
  listByJob(jobId) {
    return getDb().prepare('SELECT * FROM queue_items WHERE job_id=? ORDER BY seq ASC').all(jobId).map(toQueueItem);
  },
  stats() {
    const rows = getDb().prepare("SELECT pool, status, COUNT(*) AS n FROM queue_items WHERE status IN ('waiting','running') GROUP BY pool, status").all();
    const out = {};
    for (const r of rows) {
      out[r.pool] = out[r.pool] || { waiting: 0, running: 0 };
      out[r.pool][r.status] = r.n;
    }
    return out;
  },
  setRemote(id, remoteTaskId) {
    getDb().prepare('UPDATE queue_items SET remote_task_id=?, updated_at=? WHERE id=?').run(String(remoteTaskId || ''), now(), id);
  },
  // 执行中心跳：长视频任务（最长 90 分钟）远超租约，不续租会被误判「执行器失联」。
  touch(id, leaseMs) {
    const t = now();
    getDb().prepare("UPDATE queue_items SET lease_until=?, updated_at=? WHERE id=? AND status='running'")
      .run(t + Math.max(1000, leaseMs || 0), t, id);
  },
  staleRunning(t = now(), workerId = '') {
    if (workerId) return getDb().prepare("SELECT * FROM queue_items WHERE status='running' AND lease_until>0 AND lease_until<? AND worker_id=?").all(t, workerId).map(toQueueItem);
    return getDb().prepare("SELECT * FROM queue_items WHERE status='running' AND lease_until>0 AND lease_until<?").all(t).map(toQueueItem);
  },
  countWaitingByOwner(ownerId) {
    if (!ownerId) return 0;
    return getDb().prepare("SELECT COUNT(*) AS n FROM queue_items WHERE owner_id=? AND status='waiting'").get(ownerId).n || 0;
  },
  // 当前用户「已入队但尚未完成」的预留额度（waiting + running）。
  // 额度校验必须把它算进去，否则并发提交会同时通过检查、一起超额。
  reservedAmount(ownerId) {
    if (!ownerId) return 0;
    const r = getDb()
      .prepare("SELECT COALESCE(SUM(amount),0) AS total FROM queue_items WHERE owner_id=? AND status IN ('waiting','running')")
      .get(ownerId);
    return Number(r?.total) || 0;
  },
  recentDurations(limit = 60) {
    return getDb().prepare("SELECT pool, started_at, finished_at FROM queue_items WHERE status='done' AND started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?").all(limit);
  },
  // 启动清理：进程重启后，上次的 waiting/running 条目已没有执行器，重放会重复渲染。
  // 统一取消（job 本身也会被 startupCleanup 标记 interrupted），而不是伪装成可恢复。
  cancelAllPending(reason = '服务重启，任务中断') {
    const t = now();
    const r = getDb().prepare("UPDATE queue_items SET status='cancelled', lease_until=0, last_error=?, finished_at=?, updated_at=? WHERE status IN ('waiting','running')")
      .run(reason, t, t);
    return r.changes || 0;
  },
  purgeFinished(beforeMs) {
    getDb().prepare("DELETE FROM queue_items WHERE status IN ('done','failed','cancelled') AND finished_at IS NOT NULL AND finished_at < ?").run(beforeMs);
  },
};

// —— 计费用量 ——
const toUsage = (r) => ({
  id: r.id,
  projectId: r.project_id,
  ownerId: r.owner_id,
  jobId: r.job_id,
  kind: r.kind,
  chapter: r.chapter || '',
  subject: r.subject || '',
  holdId: r.hold_id || '',
  note: r.note || '',
  quantity: r.quantity,
  unitPrice: r.unit_price,
  amount: r.amount,
  currency: r.currency,
  reported: !!r.reported,
  reportError: r.report_error,
  reportAttempts: r.report_attempts || 0,
  nextRetryAt: r.next_retry_at || 0,
  createdAt: r.created_at,
});

export const Usage = {
  add({ projectId = '', ownerId = '', jobId = '', kind = '', chapter = '', subject = '', holdId = '', note = '', quantity = 0, unitPrice = 0, amount = 0, currency = '' }) {
    const id = uid();
    const t = now();
    getDb()
      .prepare('INSERT INTO usage_events (id,project_id,owner_id,job_id,kind,chapter,subject,hold_id,note,quantity,unit_price,amount,currency,reported,report_error,report_attempts,next_retry_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, ownerId, jobId, kind, chapter, subject, holdId, note, Number(quantity) || 0, Number(unitPrice) || 0, Number(amount) || 0, currency, 0, '', 0, 0, t);
    return this.get(id);
  },
  get(id) {
    const r = getDb().prepare('SELECT * FROM usage_events WHERE id = ?').get(id);
    return r ? toUsage(r) : null;
  },
  list({ limit = 50, projectId = '', ownerId = '' } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    if (projectId) return getDb().prepare('SELECT * FROM usage_events WHERE project_id=? ORDER BY created_at DESC LIMIT ?').all(projectId, lim).map(toUsage);
    if (ownerId) return getDb().prepare('SELECT * FROM usage_events WHERE owner_id=? ORDER BY created_at DESC LIMIT ?').all(ownerId, lim).map(toUsage);
    return getDb().prepare('SELECT * FROM usage_events ORDER BY created_at DESC LIMIT ?').all(lim).map(toUsage);
  },
  stats({ since = 0 } = {}) {
    return getDb()
      .prepare('SELECT kind, COUNT(*) AS count, SUM(quantity) AS quantity, SUM(amount) AS amount, currency FROM usage_events WHERE created_at>=? GROUP BY kind, currency')
      .all(since)
      .map((r) => ({ kind: r.kind, count: r.count, quantity: r.quantity || 0, amount: Math.round((r.amount || 0) * 100) / 100, currency: r.currency }));
  },
  markReported(id, error = '') {
    getDb().prepare('UPDATE usage_events SET reported=?, report_error=?, next_retry_at=0 WHERE id=?').run(error ? 0 : 1, String(error).slice(0, 500), id);
  },
  markReportFailed(id, error, nextRetryAt, attempts) {
    getDb()
      .prepare('UPDATE usage_events SET reported=0, report_error=?, report_attempts=?, next_retry_at=? WHERE id=?')
      .run(String(error || '').slice(0, 500), Number(attempts) || 0, Number(nextRetryAt) || 0, id);
  },
  pendingReports(nowTs, limit = 20) {
    return getDb()
      .prepare('SELECT * FROM usage_events WHERE reported=0 AND next_retry_at>0 AND next_retry_at<=? ORDER BY next_retry_at ASC LIMIT ?')
      .all(nowTs, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map(toUsage);
  },
  sumSince(ownerId, since) {
    if (!ownerId) return 0;
    const r = getDb().prepare('SELECT COALESCE(SUM(amount),0) AS total FROM usage_events WHERE owner_id=? AND created_at>=?').get(ownerId, since);
    return Number(r?.total) || 0;
  },
  // 按项目汇总（用户可见的“本项目已消耗”）
  sumByProject(ownerId, since = 0) {
    if (!ownerId) return [];
    return getDb()
      .prepare('SELECT project_id AS "projectId", currency, COALESCE(SUM(amount),0) AS amount FROM usage_events WHERE owner_id=? AND created_at>=? GROUP BY project_id, currency')
      .all(ownerId, since)
      .map((r) => ({ projectId: r.projectId, currency: r.currency, amount: Math.round((Number(r.amount) || 0) * 100) / 100 }));
  },
  // 消费明细：带项目名、任务状态和计费备注（中断后仍计费会写 note）
  listDetailed({ ownerId = '', projectId = '', kind = '', since = 0, interrupted = false, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (ownerId) { where.push('u.owner_id = ?'); params.push(ownerId); }
    if (projectId) { where.push('u.project_id = ?'); params.push(projectId); }
    if (kind) { where.push('u.kind = ?'); params.push(kind); }
    if (since > 0) { where.push('u.created_at >= ?'); params.push(since); }
    if (interrupted) where.push("u.note <> ''");
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    return getDb()
      .prepare(
        'SELECT u.*, p.name AS project_name, j.type AS job_type, j.status AS job_status, j.phase AS job_phase, j.error AS job_error'
        + ' FROM usage_events u LEFT JOIN projects p ON p.id = u.project_id LEFT JOIN jobs j ON j.id = u.job_id'
        + w + ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?',
      )
      .all(...params, lim, off)
      .map((r) => ({
        ...toUsage(r),
        projectName: r.project_name || '',
        jobType: r.job_type || '',
        jobStatus: r.job_status || '',
        jobPhase: r.job_phase || '',
        jobError: r.job_error || '',
      }));
  },
  countDetailed({ ownerId = '', projectId = '', kind = '', since = 0, interrupted = false } = {}) {
    const where = [];
    const params = [];
    if (ownerId) { where.push('u.owner_id = ?'); params.push(ownerId); }
    if (projectId) { where.push('u.project_id = ?'); params.push(projectId); }
    if (kind) { where.push('u.kind = ?'); params.push(kind); }
    if (since > 0) { where.push('u.created_at >= ?'); params.push(since); }
    if (interrupted) where.push("u.note <> ''");
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    return getDb().prepare('SELECT COUNT(*) AS n FROM usage_events u' + w).get(...params)?.n || 0;
  },
  statsFor({ ownerId = '', projectId = '', since = 0 } = {}) {
    const where = [];
    const params = [];
    if (ownerId) { where.push('owner_id = ?'); params.push(ownerId); }
    if (projectId) { where.push('project_id = ?'); params.push(projectId); }
    if (since > 0) { where.push('created_at >= ?'); params.push(since); }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    return getDb()
      .prepare('SELECT kind, COUNT(*) AS count, SUM(quantity) AS quantity, SUM(amount) AS amount, currency FROM usage_events' + w + ' GROUP BY kind, currency')
      .all(...params)
      .map((r) => ({ kind: r.kind, count: r.count, quantity: r.quantity || 0, amount: Math.round((Number(r.amount) || 0) * 100) / 100, currency: r.currency }));
  },
};

// —— 本地积分钱包 ——
// balance 是“可用余额”：hold 时立即扣除，capture 不重复扣，release 退回。
// held 只用于展示“在途”，余额里已经不含它；total = balance + held。
function addLedger({ ownerId, type = '', amount = 0, balanceAfter = 0, note = '', refId = '' }) {
  getDb()
    .prepare('INSERT INTO wallet_ledger (id,owner_id,type,amount,balance_after,note,ref_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(uid(), ownerId, type, Number(amount) || 0, Number(balanceAfter) || 0, String(note || ''), String(refId || ''), now());
}

export const Wallet = {
  ensure(ownerId, currency = '') {
    if (!ownerId) return null;
    getDb()
      .prepare('INSERT INTO wallets (owner_id,balance,currency,updated_at) VALUES (?,?,?,?) ON CONFLICT(owner_id) DO NOTHING')
      .run(String(ownerId), 0, String(currency || ''), now());
    return this.get(ownerId);
  },
  get(ownerId) {
    if (!ownerId) return null;
    const r = getDb().prepare('SELECT * FROM wallets WHERE owner_id=?').get(String(ownerId));
    if (!r) return null;
    const heldRow = getDb()
      .prepare("SELECT COALESCE(SUM(amount),0) AS total FROM wallet_holds WHERE owner_id=? AND status='held'")
      .get(String(ownerId));
    const balance = Math.round((Number(r.balance) || 0) * 100) / 100;
    const held = Math.round((Number(heldRow?.total) || 0) * 100) / 100;
    return {
      ownerId: r.owner_id,
      balance,
      held,
      available: balance,
      total: Math.round((balance + held) * 100) / 100,
      currency: r.currency || '',
      updatedAt: r.updated_at,
    };
  },
  credit(ownerId, amount, { type = 'topup', note = '', refId = '' } = {}) {
    const id = String(ownerId || '');
    const delta = Math.round((Number(amount) || 0) * 100) / 100;
    if (!id || !delta) return this.get(id);
    return tx(() => {
      this.ensure(id, '');
      const row = getDb().prepare('SELECT balance FROM wallets WHERE owner_id=?').get(id);
      const next = Math.round(((Number(row?.balance) || 0) + delta) * 100) / 100;
      if (next < 0) throw new Error('余额不足，不能扣减到负数');
      getDb().prepare('UPDATE wallets SET balance=?, updated_at=? WHERE owner_id=?').run(next, now(), id);
      addLedger({ ownerId: id, type, amount: delta, balanceAfter: next, note, refId });
      return this.get(id);
    });
  },
};

export const WalletHolds = {
  get(id) {
    const r = getDb().prepare('SELECT * FROM wallet_holds WHERE id=?').get(String(id || ''));
    return r ? toWalletHold(r) : null;
  },
  getByKey(key) {
    const k = String(key || '');
    if (!k) return null;
    const r = getDb().prepare('SELECT * FROM wallet_holds WHERE hold_key=?').get(k);
    return r ? toWalletHold(r) : null;
  },
  // 原子预授权：同一事务里扣余额 + 写 hold。余额不足返回 null。
  createHeld({ ownerId, amount, currency = '', key, jobId = '', projectId = '', kind = '', chapter = '', subject = '', ttlMs = 48 * 3600 * 1000 }) {
    const id = String(ownerId || '');
    const amt = Math.round((Number(amount) || 0) * 100) / 100;
    const holdKey = String(key || '');
    if (!id || !(amt > 0) || !holdKey) return null;
    return tx(() => {
      const existing = this.getByKey(holdKey);
      if (existing) return existing;
      Wallet.ensure(id, currency);
      const t = now();
      const r = getDb()
        .prepare('UPDATE wallets SET balance=balance-?, updated_at=? WHERE owner_id=? AND balance>=?')
        .run(amt, t, id, amt);
      if (!(r.changes > 0)) return null;
      const balance = Number(getDb().prepare('SELECT balance FROM wallets WHERE owner_id=?').get(id)?.balance) || 0;
      getDb()
        .prepare('INSERT INTO wallet_holds (id,owner_id,amount,currency,hold_key,job_id,project_id,kind,chapter,subject,status,usage_id,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(uid(), id, amt, String(currency || ''), holdKey, String(jobId || ''), String(projectId || ''), String(kind || ''), String(chapter || ''), String(subject || ''), 'held', '', t, t, t + Math.max(60_000, Number(ttlMs) || 0));
      const row = getDb().prepare('SELECT * FROM wallet_holds WHERE hold_key=?').get(holdKey);
      addLedger({ ownerId: id, type: 'hold', amount: -amt, balanceAfter: balance, note: kind || '', refId: row.id });
      return toWalletHold(row);
    });
  },
  setJobId(id, jobId) {
    getDb().prepare('UPDATE wallet_holds SET job_id=?, updated_at=? WHERE id=?').run(String(jobId || ''), now(), String(id || ''));
  },
  activeAmount(ownerId) {
    if (!ownerId) return 0;
    const r = getDb().prepare("SELECT COALESCE(SUM(amount),0) AS total FROM wallet_holds WHERE owner_id=? AND status='held'").get(String(ownerId));
    return Number(r?.total) || 0;
  },
  // 捕获：hold -> usage；不重复扣余额。返回 usage 行。
  capture(idOrKey, { cfg, quantity, unitPrice, chapter, subject, note = '' } = {}) {
    const key = String(idOrKey || '');
    if (!key) return null;
    return tx(() => {
      const row = this.get(key) || this.getByKey(key);
      if (!row) return null;
      if (row.status === 'captured') return row.usageId ? Usage.get(row.usageId) : null;
      if (row.status === 'released') return null;
      const usage = Usage.add({
        projectId: row.projectId,
        ownerId: row.ownerId,
        jobId: row.jobId,
        kind: row.kind,
        chapter: chapter != null ? chapter : row.chapter,
        subject: subject != null ? subject : row.subject,
        holdId: row.id,
        note,
        quantity: quantity != null ? quantity : 1,
        unitPrice: unitPrice != null ? unitPrice : row.amount,
        amount: row.amount,
        currency: row.currency,
      });
      getDb().prepare("UPDATE wallet_holds SET status='captured', usage_id=?, updated_at=? WHERE id=? AND status='held'").run(usage.id, now(), row.id);
      const balance = Number(getDb().prepare('SELECT balance FROM wallets WHERE owner_id=?').get(row.ownerId)?.balance) || 0;
      addLedger({ ownerId: row.ownerId, type: 'capture', amount: 0, balanceAfter: balance, note: row.kind, refId: usage.id });
      return usage;
    });
  },
  // 释放：hold -> released，余额退回。
  release(idOrKey, note = '') {
    const key = String(idOrKey || '');
    if (!key) return null;
    return tx(() => {
      const row = this.get(key) || this.getByKey(key);
      if (!row || row.status !== 'held') return row;
      getDb().prepare("UPDATE wallet_holds SET status='released', updated_at=? WHERE id=? AND status='held'").run(now(), row.id);
      getDb().prepare('UPDATE wallets SET balance=balance+?, updated_at=? WHERE owner_id=?').run(row.amount, now(), row.ownerId);
      const balance = Number(getDb().prepare('SELECT balance FROM wallets WHERE owner_id=?').get(row.ownerId)?.balance) || 0;
      addLedger({ ownerId: row.ownerId, type: 'release', amount: row.amount, balanceAfter: balance, note: note || row.kind, refId: row.id });
      return this.get(row.id);
    });
  },
  releaseAllHeld(reason = '服务重启') {
    const rows = getDb().prepare("SELECT * FROM wallet_holds WHERE status='held'").all().map(toWalletHold);
    for (const r of rows) {
      try { this.release(r.id, reason); } catch { /* 忽略单条 */ }
    }
    return rows.length;
  },
  releaseExpired(nowTs = Date.now()) {
    const rows = getDb().prepare("SELECT * FROM wallet_holds WHERE status='held' AND expires_at>0 AND expires_at<?").all(nowTs).map(toWalletHold);
    for (const r of rows) {
      try { this.release(r.id, '预授权过期'); } catch { /* 忽略 */ }
    }
    return rows.length;
  },
};

const toWalletHold = (r) => ({
  id: r.id,
  ownerId: r.owner_id,
  amount: Number(r.amount) || 0,
  currency: r.currency || '',
  key: r.hold_key,
  jobId: r.job_id || '',
  projectId: r.project_id || '',
  kind: r.kind || '',
  chapter: r.chapter || '',
  subject: r.subject || '',
  status: r.status,
  usageId: r.usage_id || '',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at || 0,
});

export const Skills = {  list() { return getDb().prepare('SELECT * FROM skills ORDER BY name ASC').all().map(toSkill); },
  get(id) { const r = getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id); return r ? toSkill(r) : null; },
  getByName(name) { const r = getDb().prepare('SELECT * FROM skills WHERE name = ?').get(name); return r ? toSkill(r) : null; },
  upsert({ name, description = '', version = '', source = 'bundled', enabled = true, path = '', manifest = {} }) {
    const existing = this.getByName(name);
    const t = now();
    if (existing) {
      getDb().prepare('UPDATE skills SET description=?, version=?, source=?, enabled=?, path=?, manifest=?, updated_at=? WHERE id=?')
        .run(description ?? existing.description, version ?? existing.version, source ?? existing.source, enabled ? 1 : 0, path || existing.path, JSON.stringify(manifest ?? {}), t, existing.id);
      return this.get(existing.id);
    }
    const id = uid();
    getDb().prepare('INSERT INTO skills (id,name,description,version,source,enabled,path,manifest,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, description, version, source, enabled ? 1 : 0, path, JSON.stringify(manifest ?? {}), t, t);
    return this.get(id);
  },
  remove(id) { getDb().prepare('DELETE FROM skills WHERE id = ?').run(id); },
};

export const Workflows = {
  list() { return getDb().prepare('SELECT * FROM workflows ORDER BY name ASC').all().map(toWorkflow); },
  get(id) { const r = getDb().prepare('SELECT * FROM workflows WHERE id = ?').get(id); return r ? toWorkflow(r) : null; },
  getByName(name) { const r = getDb().prepare('SELECT * FROM workflows WHERE name = ?').get(name); return r ? toWorkflow(r) : null; },
  upsert({ name, kind = 'custom', sourceFile = '', spec = {}, status = 'active' }) {
    const existing = this.getByName(name);
    const t = now();
    if (existing) {
      getDb().prepare('UPDATE workflows SET kind=?, source_file=?, spec=?, status=?, updated_at=? WHERE id=?')
        .run(kind ?? existing.kind, sourceFile || existing.sourceFile, JSON.stringify(spec ?? {}), status ?? existing.status, t, existing.id);
      return this.get(existing.id);
    }
    const id = uid();
    getDb().prepare('INSERT INTO workflows (id,name,kind,source_file,spec,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, name, kind, sourceFile, JSON.stringify(spec ?? {}), status, t, t);
    return this.get(id);
  },
  remove(id) { getDb().prepare('DELETE FROM workflows WHERE id = ?').run(id); },
};

export const Messages = {
  add({ projectId, jobId = '', role = 'assistant', content = '' }) {
    const id = uid(); const t = now();
    const seq = (getDb().prepare('SELECT MAX(seq) AS m FROM messages WHERE job_id = ?').get(jobId)?.m ?? 0) + 1;
    getDb().prepare('INSERT INTO messages (id,project_id,job_id,seq,role,content,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, projectId, jobId, seq, role, content, t);
    return { id, seq, role, content, createdAt: t };
  },
  listByJob(jobId, limit = 200) {
    return getDb().prepare('SELECT * FROM messages WHERE job_id = ? ORDER BY seq ASC LIMIT ?').all(jobId, limit)
      .map((r) => ({ id: r.id, projectId: r.project_id, jobId: r.job_id, seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at }));
  },
  clearJob(jobId) { getDb().prepare('DELETE FROM messages WHERE job_id = ?').run(jobId); },
};
