import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.js';
import { uid, now, safeJsonParse } from './utils.js';

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
        seq INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
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
    try { db.exec("ALTER TABLE assets ADD COLUMN prompt_used TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE assets ADD COLUMN voice_desc_used TEXT DEFAULT ''"); } catch {}
    // 回填：老库中已生成的资产假定「当前 prompt 就是当初用的」，避免升级后被判为改过而全量重生成
    try { db.exec("UPDATE assets SET prompt_used = prompt WHERE prompt_used = '' AND status = 'done' AND image_path <> ''"); } catch {}
    try { db.exec("UPDATE assets SET voice_desc_used = voice_desc WHERE voice_desc_used = '' AND voice_ref <> ''"); } catch {}
    // 迁移：多章节结构 —— 为每个项目补齐「第1章」，把旧 novel 迁过去并归类已有分镜
    try {
      db.exec("CREATE TABLE IF NOT EXISTS chapters (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT DEFAULT '', novel TEXT DEFAULT '', seq INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', created_at INTEGER, updated_at INTEGER)");
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

const toProject = (r) => ({ ...r, context: safeJsonParse(r.context, {}) });
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

export const Projects = {
  list() { return getDb().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map(toProject); },
  get(id) { const r = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id); return r ? toProject(r) : null; },
  create({ name, novel = '', idea = '', style = '', video_resolution = '480P', video_aspect_ratio = '16:9', video_width = 0, video_height = 0, target_duration = 0 }) {
    const id = uid(); const t = now();
    getDb().prepare('INSERT INTO projects (id,name,novel,idea,style,video_resolution,video_aspect_ratio,video_width,video_height,target_duration,context,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, novel, idea, style, video_resolution, video_aspect_ratio, video_width, video_height, target_duration, '{}', 'idle', t, t);
    // 自动创建「第1章」并承载新建时粘贴的小说
    getDb().prepare('INSERT INTO chapters (id,project_id,title,novel,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(uid(), id, '第1章', novel, 1, 'pending', t, t);
    return this.get(id);
  },
  update(id, fields) {
    const p = this.get(id); if (!p) return null;
    const m = { ...p, ...fields, updated_at: now() };
    getDb().prepare('UPDATE projects SET name=?, novel=?, idea=?, style=?, video_resolution=?, video_aspect_ratio=?, video_width=?, video_height=?, target_duration=?, context=?, status=?, updated_at=? WHERE id=?')
      .run(m.name, m.novel ?? '', m.idea ?? '', m.style ?? '', m.video_resolution ?? '480P', m.video_aspect_ratio ?? '16:9', m.video_width ?? 0, m.video_height ?? 0, m.target_duration ?? 0, JSON.stringify(m.context ?? {}), m.status ?? 'idle', m.updated_at, id);
    return this.get(id);
  },
  remove(id) {
    getDb().prepare('DELETE FROM assets WHERE project_id = ?').run(id);
    getDb().prepare('DELETE FROM shots WHERE project_id = ?').run(id);
    getDb().prepare('DELETE FROM jobs WHERE project_id = ?').run(id);
    getDb().prepare('DELETE FROM messages WHERE project_id = ?').run(id);
    getDb().prepare('DELETE FROM chapters WHERE project_id = ?').run(id);
    getDb().prepare('DELETE FROM reference_images WHERE project_id = ?').run(id);
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
};

export const Assets = {
  list(projectId, category) {
    if (category) return getDb().prepare('SELECT * FROM assets WHERE project_id = ? AND category = ? ORDER BY created_at ASC').all(projectId, category).map(toAsset);
    return getDb().prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at ASC').all(projectId).map(toAsset);
  },
  get(id) { const r = getDb().prepare('SELECT * FROM assets WHERE id = ?').get(id); return r ? toAsset(r) : null; },
  create(projectId, { category = 'other', name, description = '', parent_id = '', voice_desc = '' }) {
    const id = uid(); const t = now();
    getDb().prepare('INSERT INTO assets (id,project_id,category,name,parent_id,description,voice_desc,prompt,negative_prompt,voice_ref,image_path,audio_path,video_path,source,consistency_key,versions,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, category, name, parent_id, description, voice_desc, '', '', '', '', '', '', 'none', '', '[]', 'pending', t, t);
    return this.get(id);
  },
  update(id, fields) {
    const a = this.get(id); if (!a) return null;
    const m = { ...a, ...fields, updated_at: now() };
    getDb().prepare('UPDATE assets SET category=?, name=?, parent_id=?, description=?, voice_desc=?, voice_desc_used=?, prompt=?, prompt_used=?, negative_prompt=?, voice_ref=?, image_path=?, audio_path=?, video_path=?, source=?, consistency_key=?, versions=?, status=?, updated_at=? WHERE id=?')
      .run(m.category, m.name, m.parent_id ?? '', m.description ?? '', m.voice_desc ?? '', m.voice_desc_used ?? '', m.prompt ?? '', m.prompt_used ?? '', m.negative_prompt ?? '', m.voice_ref ?? '', m.image_path ?? '', m.audio_path ?? '', m.video_path ?? '', m.source ?? 'none', m.consistency_key ?? '', JSON.stringify(m.versions ?? []), m.status ?? 'pending', m.updated_at, id);
    return this.get(id);
  },
  remove(id) { getDb().prepare('DELETE FROM assets WHERE id = ?').run(id); },
};

export const Shots = {
  list(projectId) { return getDb().prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY idx ASC').all(projectId).map(toShot); },
  get(id) { const r = getDb().prepare('SELECT * FROM shots WHERE id = ?').get(id); return r ? toShot(r) : null; },
  create(projectId, shot = {}) {
    const id = uid(); const t = now();
    const max = getDb().prepare('SELECT MAX(idx) AS m FROM shots WHERE project_id = ?').get(projectId)?.m ?? 0;
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
    return this.get(id);
  },
  update(id, fields) {
    const s = this.get(id); if (!s) return null;
    const m = { ...s, ...fields, updated_at: now() };
    const character_ids = Array.isArray(fields.character_ids) ? fields.character_ids.filter(Boolean) : (s.character_ids || []);
    const scene_ids = Array.isArray(fields.scene_ids) ? fields.scene_ids.filter(Boolean) : (s.scene_ids || []);
    const prop_ids = Array.isArray(fields.prop_ids) ? fields.prop_ids.filter(Boolean) : (s.prop_ids || []);
    const costume_ids = Array.isArray(fields.costume_ids) ? fields.costume_ids.filter(Boolean) : (s.costume_ids || []);
    const age_ids = Array.isArray(fields.age_ids) ? fields.age_ids.filter(Boolean) : (s.age_ids || []);
    const audio_ids = Array.isArray(fields.audio_ids) ? fields.audio_ids.filter(Boolean) : (s.audio_ids || []);
    const references = Array.isArray(fields.references) ? fields.references : (s.references || []);
    getDb().prepare('UPDATE shots SET idx=?, chapter=?, scene_name=?, camera=?, visual=?, dialogue=?, narration=?, sub_shots=?, prompt_id=?, duration=?, character_ids=?, scene_ids=?, prop_ids=?, costume_ids=?, age_ids=?, audio_ids=?, refs=?, resolution=?, aspect_ratio=?, video_prompt=?, video_path=?, seed=?, status=?, error=?, parent_shot_id=?, updated_at=? WHERE id=?')
      .run(m.idx, m.chapter ?? '', m.scene_name ?? '', m.camera ?? '', m.visual ?? '', m.dialogue ?? '', m.narration ?? '', m.sub_shots ?? '', m.prompt_id ?? '',
        m.duration ?? 5, JSON.stringify(character_ids), JSON.stringify(scene_ids), JSON.stringify(prop_ids), JSON.stringify(costume_ids), JSON.stringify(age_ids), JSON.stringify(audio_ids), JSON.stringify(references),
        m.resolution ?? '480P', m.aspect_ratio ?? '16:9', m.video_prompt ?? '', m.video_path ?? '', m.seed ?? 0, m.status ?? 'pending', m.error ?? '', m.parent_shot_id ?? '', m.updated_at, id);
    return this.get(id);
  },
  remove(id) { getDb().prepare('DELETE FROM shots WHERE id = ?').run(id); },
};

export const Chapters = {
  list(projectId) { return getDb().prepare('SELECT * FROM chapters WHERE project_id = ? ORDER BY seq ASC').all(projectId).map(toChapter); },
  get(id) { const r = getDb().prepare('SELECT * FROM chapters WHERE id = ?').get(id); return r ? toChapter(r) : null; },
  create(projectId, { title = '', novel = '' } = {}) {
    const id = uid(); const t = now();
    const maxSeq = getDb().prepare('SELECT MAX(seq) AS s FROM chapters WHERE project_id = ?').get(projectId)?.s ?? 0;
    const seq = maxSeq + 1;
    const title2 = title || ('第' + seq + '章');
    getDb().prepare('INSERT INTO chapters (id,project_id,title,novel,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, projectId, title2, novel, seq, 'pending', t, t);
    return this.get(id);
  },
  update(id, fields) {
    const c = this.get(id); if (!c) return null;
    const m = { ...c, ...fields, updated_at: now() };
    getDb().prepare('UPDATE chapters SET title=?, novel=?, seq=?, status=?, updated_at=? WHERE id=?')
      .run(m.title ?? '', m.novel ?? '', m.seq ?? 0, m.status ?? 'pending', m.updated_at, id);
    return this.get(id);
  },
  remove(id) {
    const c = this.get(id); if (!c) return null;
    getDb().prepare('DELETE FROM shots WHERE project_id = ? AND chapter = ?').run(c.project_id, c.title);
    getDb().prepare('DELETE FROM chapters WHERE id = ?').run(id);
    return true;
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
    return this.get(id);
  },
  update(id, fields) {
    const a = this.get(id); if (!a) return null;
    const m = { ...a, ...fields };
    getDb().prepare('UPDATE reference_images SET chapter_id=?, asset_id=?, name=?, image_path=?, mode=?, category=?, description=? WHERE id=?')
      .run(m.chapter_id ?? '', m.asset_id ?? '', m.name ?? '', m.image_path ?? '', m.mode ?? 'reference', m.category ?? 'other', m.description ?? '', id);
    return this.get(id);
  },
  remove(id) { getDb().prepare('DELETE FROM reference_images WHERE id = ?').run(id); },
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
