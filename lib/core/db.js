import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.js';
import { uid, now, safeJsonParse } from './utils.js';
import { recordChange, rawGet } from './changelog.js';
import { ASSET_CATEGORY_IDS, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS, isVariantAssetCategory } from '../shared/index.js';

let db;
export function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
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
        status TEXT DEFAULT 'pending',
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
      CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
      CREATE INDEX IF NOT EXISTS idx_shots_project ON shots(project_id);
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
    try { db.exec("ALTER TABLE assets ADD COLUMN prompt_used TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE assets ADD COLUMN voice_desc_used TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE assets ADD COLUMN lyrics TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE assets ADD COLUMN max_duration REAL DEFAULT 0"); } catch {}
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
      const assetCols = db.prepare('PRAGMA table_info(assets)').all().map((c) => c.name);
      if (!assetCols.includes('voice_desc')) {
        try { db.exec("ALTER TABLE assets ADD COLUMN voice_desc TEXT DEFAULT ''"); } catch { /* 忽略失败 */ }
      }
    }
    // 迁移：参考素材不再区分项目级，把 chapter_id 为空的旧数据归入各项目「第1章」
    try {
      db.prepare("UPDATE reference_images SET chapter_id = (SELECT c.id FROM chapters c WHERE c.project_id = reference_images.project_id ORDER BY c.seq ASC LIMIT 1) WHERE chapter_id = ''").run();
    } catch (e) { /* 忽略迁移失败 */ }
  }
  return db;
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
}

const toProject = (r) => ({ ...r, context: safeJsonParse(r.context, {}), enable_bgm: !!r.enable_bgm });
const toAsset = (r) => ({ ...r, versions: safeJsonParse(r.versions, []) });
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

export const Projects = {
  list() { return getDb().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map(toProject); },
  get(id) { const r = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id); return r ? toProject(r) : null; },
  create({ name, novel = '', idea = '', style = '', video_resolution = '480P', video_aspect_ratio = '16:9', video_width = 0, video_height = 0, target_duration = 0 }) {
    const id = uid(); const t = now();
    const enums = projectEnums({ video_resolution, video_aspect_ratio });
    getDb().prepare('INSERT INTO projects (id,name,novel,idea,style,video_resolution,video_aspect_ratio,video_width,video_height,target_duration,context,status,enable_bgm,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, novel, idea, style, enums.video_resolution, enums.video_aspect_ratio, video_width, video_height, target_duration, '{}', 'idle', 1, t, t);
    // 自动创建「第1章」并承载新建时粘贴的小说
    const chapterId = uid();
    getDb().prepare('INSERT INTO chapters (id,project_id,title,novel,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(chapterId, id, '第1章', novel, 1, 'pending', t, t);
    recordChange({ entity: 'project', action: 'create', after: rawGet('project', id) });
    recordChange({ entity: 'chapter', action: 'create', after: rawGet('chapter', chapterId) });
    return this.get(id);
  },
  update(id, fields) {
    const p = this.get(id); if (!p) return null;
    const before = rawGet('project', id);
    const m = { ...p, ...fields, updated_at: now() };
    // 只校验本次真正要写的两个枚举字段：存量行里的历史值不该让「改个名字」也失败
    Object.assign(m, projectEnums(fields || {}));
    getDb().prepare('UPDATE projects SET name=?, novel=?, idea=?, style=?, video_resolution=?, video_aspect_ratio=?, video_width=?, video_height=?, target_duration=?, context=?, status=?, enable_bgm=?, updated_at=? WHERE id=?')
      .run(m.name, m.novel ?? '', m.idea ?? '', m.style ?? '', m.video_resolution ?? '480P', m.video_aspect_ratio ?? '16:9', m.video_width ?? 0, m.video_height ?? 0, m.target_duration ?? 0, JSON.stringify(m.context ?? {}), m.status ?? 'idle', m.enable_bgm ? 1 : 0, m.updated_at, id);
    recordChange({ entity: 'project', action: 'update', before, after: rawGet('project', id) });
    return this.get(id);
  },
  remove(id) {
    // 删项目要动 7 张表：包事务，避免中途失败留下「项目还在、章节/分镜已删」的残骸
    tx(() => {
      getDb().prepare('DELETE FROM assets WHERE project_id = ?').run(id);
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
    // prompt 必须由 create 自己写库：调用方（换装/年龄变体）在 create 时就把提示词传进来了，
    // 早先这里漏收 prompt/negative_prompt，导致变体资产入库后提示词为空 —— 用户在素材库改提示词
    // 毫无作用（旧变体的 prompt 恒为 ''，重新生成时按「同名已存在」直接复用旧图）。
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
    // 同 create：改分类/parent_id 时不许把行留成「无父变体」。只在调用方**主动动这两列**时拦，
    // 这样修好之前已经落库的存量无父变体仍能改名/清理（守卫不误伤旧数据）。
    if (fields && (fields.category !== undefined || fields.parent_id !== undefined)
      && isVariantAssetCategory(fields.category === undefined ? a.category : fields.category)
      && !(fields.parent_id === undefined ? a.parent_id : fields.parent_id)) {
      throw Object.assign(new Error('服装/年龄变体必须绑定角色（parent_id）'), { code: 'BAD_VARIANT_PARENT' });
    }
    getDb().prepare('UPDATE assets SET category=?, name=?, parent_id=?, description=?, voice_desc=?, voice_desc_used=?, prompt=?, prompt_used=?, prompt_locked=?, lyrics=?, max_duration=?, negative_prompt=?, voice_ref=?, image_path=?, audio_path=?, video_path=?, source=?, consistency_key=?, versions=?, status=?, updated_at=? WHERE id=?')
      .run(m.category, m.name, m.parent_id ?? '', m.description ?? '', m.voice_desc ?? '', m.voice_desc_used ?? '', m.prompt ?? '', m.prompt_used ?? '', m.prompt_locked ? 1 : 0, m.lyrics ?? '', m.max_duration ?? 0, m.negative_prompt ?? '', m.voice_ref ?? '', m.image_path ?? '', m.audio_path ?? '', m.video_path ?? '', m.source ?? 'none', m.consistency_key ?? '', JSON.stringify(m.versions ?? []), m.status ?? 'pending', m.updated_at, id);
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
    const character_ids = Array.isArray(shot.character_ids) ? shot.character_ids.filter(Boolean) : [];
    const scene_ids = Array.isArray(shot.scene_ids) ? shot.scene_ids.filter(Boolean) : [];
    const prop_ids = Array.isArray(shot.prop_ids) ? shot.prop_ids.filter(Boolean) : [];
    const costume_ids = Array.isArray(shot.costume_ids) ? shot.costume_ids.filter(Boolean) : [];
    const age_ids = Array.isArray(shot.age_ids) ? shot.age_ids.filter(Boolean) : [];
    const audio_ids = Array.isArray(shot.audio_ids) ? shot.audio_ids.filter(Boolean) : [];
    getDb().prepare('INSERT INTO shots (id,project_id,idx,chapter,scene_name,camera,visual,dialogue,narration,sub_shots,prompt_id,duration,character_ids,scene_ids,prop_ids,costume_ids,age_ids,audio_ids,refs,resolution,aspect_ratio,video_prompt,video_path,seed,status,error,parent_shot_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, idx, shot.chapter ?? '', shot.scene_name ?? '', shot.camera ?? '', shot.visual ?? '', shot.dialogue ?? '', shot.narration ?? '', shot.sub_shots ?? '', shot.prompt_id ?? '',
        shot.duration ?? 5, JSON.stringify(character_ids), JSON.stringify(scene_ids), JSON.stringify(prop_ids), JSON.stringify(costume_ids), JSON.stringify(age_ids), JSON.stringify(audio_ids), JSON.stringify(shot.references ?? []),
        shot.resolution ?? '480P', shot.aspect_ratio ?? '16:9', shot.video_prompt ?? '', shot.video_path ?? '', shot.seed ?? 0, shot.status ?? 'pending', '', shot.parent_shot_id ?? '', t, t);
    recordChange({ entity: 'shot', action: 'create', after: rawGet('shot', id) });
    return this.get(id);
  },
  update(id, fields) {
    const s = this.get(id); if (!s) return null;
    const before = rawGet('shot', id);
    const m = { ...s, ...fields, updated_at: now() };
    const character_ids = Array.isArray(fields.character_ids) ? fields.character_ids.filter(Boolean) : (s.character_ids || []);
    const scene_ids = Array.isArray(fields.scene_ids) ? fields.scene_ids.filter(Boolean) : (s.scene_ids || []);
    const prop_ids = Array.isArray(fields.prop_ids) ? fields.prop_ids.filter(Boolean) : (s.prop_ids || []);
    const costume_ids = Array.isArray(fields.costume_ids) ? fields.costume_ids.filter(Boolean) : (s.costume_ids || []);
    const age_ids = Array.isArray(fields.age_ids) ? fields.age_ids.filter(Boolean) : (s.age_ids || []);
    const audio_ids = Array.isArray(fields.audio_ids) ? fields.audio_ids.filter(Boolean) : (s.audio_ids || []);
    const references = Array.isArray(fields.references) ? fields.references : (s.references || []);
    getDb().prepare('UPDATE shots SET idx=?, chapter=?, scene_name=?, camera=?, visual=?, dialogue=?, narration=?, sub_shots=?, prompt_id=?, duration=?, character_ids=?, scene_ids=?, prop_ids=?, costume_ids=?, age_ids=?, audio_ids=?, refs=?, resolution=?, aspect_ratio=?, video_prompt=?, video_prompt_used=?, video_path=?, seed=?, status=?, error=?, parent_shot_id=?, updated_at=? WHERE id=?')
      .run(m.idx, m.chapter ?? '', m.scene_name ?? '', m.camera ?? '', m.visual ?? '', m.dialogue ?? '', m.narration ?? '', m.sub_shots ?? '', m.prompt_id ?? '',
        m.duration ?? 5, JSON.stringify(character_ids), JSON.stringify(scene_ids), JSON.stringify(prop_ids), JSON.stringify(costume_ids), JSON.stringify(age_ids), JSON.stringify(audio_ids), JSON.stringify(references),
        m.resolution ?? '480P', m.aspect_ratio ?? '16:9', m.video_prompt ?? '', m.video_prompt_used ?? '', m.video_path ?? '', m.seed ?? 0, m.status ?? 'pending', m.error ?? '', m.parent_shot_id ?? '', m.updated_at, id);
    recordChange({ entity: 'shot', action: 'update', before, after: rawGet('shot', id) });
    return this.get(id);
  },
  remove(id) {
    const before = rawGet('shot', id);
    getDb().prepare('DELETE FROM shots WHERE id = ?').run(id);
    if (before) recordChange({ entity: 'shot', action: 'delete', before });
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
    const title2 = String(title ?? '').trim() ? title : ('第' + seq + '章');
    assertChapterTitleFree(projectId, title2);
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
  create(projectId, { chapter_id = '', asset_id = '', name = '', image_path = '', mode = 'reference', category = 'other', description = '' }) {
    const id = uid(); const t = now();
    getDb().prepare('INSERT INTO reference_images (id,project_id,chapter_id,asset_id,name,image_path,mode,category,description,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, chapter_id, asset_id, name, image_path, mode, category, description, t);
    recordChange({ entity: 'reference', action: 'create', after: rawGet('reference', id) });
    return this.get(id);
  },
  update(id, fields) {
    const a = this.get(id); if (!a) return null;
    const before = rawGet('reference', id);
    const m = { ...a, ...fields };
    getDb().prepare('UPDATE reference_images SET chapter_id=?, asset_id=?, name=?, image_path=?, mode=?, category=?, description=? WHERE id=?')
      .run(m.chapter_id ?? '', m.asset_id ?? '', m.name ?? '', m.image_path ?? '', m.mode ?? 'reference', m.category ?? 'other', m.description ?? '', id);
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

export const Skills = {
  list() { return getDb().prepare('SELECT * FROM skills ORDER BY name ASC').all().map(toSkill); },
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
