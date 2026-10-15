// 可回滚变更日志：内容表（projects / chapters / shots / assets / reference_images）的
// 每次增删改都留一份「原始行快照」，支持按单条 / 按批次 / 按时间点逆序回滚。
//
// 设计要点：
// 1) 埋点在 DB 层（db.js 调用 recordChange），所以前端 UI、内置 Agent、外部 harness
//    三方写入全部被覆盖；来源与批次用 AsyncLocalStorage 传递，异步并发下不会串号。
// 2) 快照存「原始 DB 行」（SELECT * 的原样文本值），回滚直接 INSERT OR REPLACE 复原，
//    不做字段映射，杜绝 toXxx 解析/序列化造成的漂移。
// 3) 回滚自身也写一条 action='rollback' 日志（before=回滚前状态，after=复原后状态），
//    所以「回滚的回滚」= 重做，链路完整、可审计。
// 4) 硬约束：绝不允许因回滚而删掉项目（entity=project 且无 before 时直接拒绝）。
import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from './db.js';
import { uid, now, safeJsonParse } from './utils.js';

const als = new AsyncLocalStorage();

// 实体 -> 表名（代码常量白名单；不接受外部输入，故拼接进 SQL 是安全的）
export const ENTITY_TABLE = {
  project: 'projects',
  chapter: 'chapters',
  shot: 'shots',
  asset: 'assets',
  reference: 'reference_images',
};

// update 若只动了这些字段则不记日志：它们是生成流水线的产物/状态，不是用户或外部写入的「内容」。
// 少了这份清单，每跑一轮视频都会为每条分镜刷出成批 status / *_path 变更，把内容日志彻底淹掉。
const VOLATILE = {
  project: new Set(['status', 'updated_at']),
  chapter: new Set(['status', 'updated_at', 'music_path', 'music_prompt_used']),
  shot: new Set(['status', 'error', 'updated_at', 'video_path', 'video_prompt_used', 'prompt_id']),
  asset: new Set(['status', 'updated_at', 'image_path', 'audio_path', 'video_path', 'voice_ref', 'prompt_used', 'voice_desc_used', 'versions']),
  reference: new Set([]),
};

// 在指定来源下执行一段写操作：同一次调用内的所有变更共享一个 batch_id，可整批回滚。
export function withWriteContext(source, fn) {
  return als.run({ source: String(source || 'internal'), batchId: uid() }, fn);
}
export function currentSource() {
  const s = als.getStore();
  return s ? s.source : 'internal';
}
export function currentBatchId() {
  const s = als.getStore();
  return s ? s.batchId : '';
}

// 读原始行（未经 toXxx 解析），存在性/归属校验与快照都用它
export function rawGet(entity, id) {
  const table = ENTITY_TABLE[entity];
  if (!table || !id) return null;
  return getDb().prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(id) || null;
}

// 项目行的「归属」是它自己（projects 表没有 project_id 列）
function projectIdOf(entity, row) {
  if (!row) return '';
  return entity === 'project' ? row.id : (row.project_id || '');
}

// 除「流水线易变字段」外是否真有内容变化
function contentChanged(entity, before, after) {
  const vol = VOLATILE[entity] || new Set();
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (vol.has(k)) continue;
    if (String(before?.[k] ?? '') !== String(after?.[k] ?? '')) return true;
  }
  return false;
}

// 记录一次内容变更。before / after 为原始行对象（null 表示该侧尚未存在）。
export function recordChange({ entity, action, before = null, after = null, entityId = '', meta = null, revertOf = '' }) {
  if (!ENTITY_TABLE[entity]) return null;
  const b = before || null;
  const a = after || null;
  const projectId = projectIdOf(entity, a || b);
  if (!projectId) return null;
  if (action === 'update' && b && a && !contentChanged(entity, b, a)) return null;
  const id = uid();
  getDb()
    .prepare('INSERT INTO change_logs (id,project_id,batch_id,ts,source,entity,entity_id,action,before,after,revert_of,reverted_by,meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, projectId, currentBatchId(), now(), currentSource(), entity, entityId || a?.id || b?.id || '', action,
      b ? JSON.stringify(b) : null, a ? JSON.stringify(a) : null, revertOf, '', meta ? JSON.stringify(meta) : '{}');
  return id;
}

const toLog = (r) => ({
  id: r.id,
  project_id: r.project_id,
  batch_id: r.batch_id,
  ts: r.ts,
  source: r.source,
  entity: r.entity,
  entity_id: r.entity_id,
  action: r.action,
  before: safeJsonParse(r.before, null),
  after: safeJsonParse(r.after, null),
  revert_of: r.revert_of,
  reverted_by: r.reverted_by,
  meta: safeJsonParse(r.meta, {}),
});

export function listChanges(projectId, { entity, action, source, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM change_logs WHERE project_id = ?';
  const args = [projectId];
  if (entity) { sql += ' AND entity = ?'; args.push(String(entity)); }
  if (action) { sql += ' AND action = ?'; args.push(String(action)); }
  if (source) { sql += ' AND source = ?'; args.push(String(source)); }
  sql += ' ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?';
  args.push(Math.min(Math.max(Number(limit) || 100, 1), 500), Math.max(Number(offset) || 0, 0));
  return getDb().prepare(sql).all(...args).map(toLog);
}

export function countChanges(projectId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM change_logs WHERE project_id = ?').get(projectId).c;
}

export function getChange(id) {
  const r = getDb().prepare('SELECT * FROM change_logs WHERE id = ?').get(id);
  return r ? toLog(r) : null;
}

// 漂移检测：只看**内容字段**。流水线刷 status / video_path / updated_at 等产物字段不算漂移——
// 否则「harness 写完分镜 → 应用顺手渲染了一轮」就会把内容回滚永久锁死。
// 存在性变化（行被删/被建）与任一内容字段不同 → 视为漂移。
function driftOf(log) {
  const cur = rawGet(log.entity, log.entity_id);
  if (!cur && !log.after) return null;                 // 该步是删除，行仍未存在 = 一致
  if (!cur || !log.after) return { current: cur, expected: log.after };
  if (contentChanged(log.entity, log.after, cur)) return { current: cur, expected: log.after };
  return null;
}

// 复原整行，但保留「当前行的产物字段」：撤销一次文本改动不应该把已渲染的 video_path/status 抹掉。
// 行已不存在（撤销删除）时没有可保留的产物，直接整行复原。
function buildRestoreRow(log, current) {
  const row = { ...log.before };
  if (current) {
    const vol = VOLATILE[log.entity] || new Set();
    for (const k of vol) if (k in current) row[k] = current[k];
  }
  return row;
}

// 生成产物字段（图片/视频/语音路径）——撤销「新建」会把这些行删掉，提醒调用方产物文件仍在磁盘上
const ARTIFACT_KEYS = ['image_path', 'audio_path', 'video_path', 'voice_ref'];

// 执行一条日志的逆操作。通用规则：把状态还原成 before ——
// before 为空说明那一步是「新建」，逆操作就是删行；否则用 before 快照整行覆盖。
// action='rollback' 的日志同样适用（其 before 是回滚前状态），因此回滚可再回滚 = 重做。
function applyInverse(log) {
  const entity = log.entity;
  const table = ENTITY_TABLE[entity];
  if (!table) throw Object.assign(new Error('未知实体：' + entity), { code: 'BAD_ENTITY' });

  if (!log.before) {
    if (entity === 'project') {
      throw Object.assign(new Error('禁止通过回滚删除项目；请在界面手动删除。'), { code: 'NO_PROJECT_DELETE' });
    }
    const cur = rawGet(entity, log.entity_id);
    const artifacts = cur ? ARTIFACT_KEYS.filter((k) => cur[k]) : [];
    let chapterShotsDeleted = 0;
    // 与 Chapters.remove 同语义：删章节时级联删该章分镜，避免回滚后留下孤立分镜
    if (entity === 'chapter' && log.after) {
      chapterShotsDeleted = getDb().prepare('DELETE FROM shots WHERE project_id = ? AND chapter = ?')
        .run(log.after.project_id, log.after.title).changes;
    }
    getDb().prepare('DELETE FROM ' + table + ' WHERE id = ?').run(log.entity_id);
    return { inverse: 'deleted', chapter_shots_deleted: chapterShotsDeleted, artifacts };
  }

  const prev = rawGet(entity, log.entity_id);
  const row = buildRestoreRow(log, prev);
  const cols = Object.keys(row);
  getDb()
    .prepare('INSERT OR REPLACE INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')')
    .run(...cols.map((c) => row[c]));
  return { inverse: 'restored' };
}

/**
 * 回滚。目标三选一：
 *   logId     —— 回滚单条
 *   batchId   —— 回滚整整一批（同一次 API / 工具调用）
 *   sinceTs   —— 回滚该时刻（含）之后的所有变更
 * force=true 时跳过漂移保护（强行覆盖新改动）。
 * 返回 { applied, skipped, conflicts, blocked }；blocked=true 表示有漂移且未 force，未做任何改动。
 */
export function rollbackLogs({ projectId, logId, batchId, sinceTs, force = false } = {}) {
  if (!projectId) throw Object.assign(new Error('缺少 projectId'), { code: 'BAD_TARGET' });
  let sql = 'SELECT * FROM change_logs WHERE project_id = ?';
  const args = [projectId];
  if (logId) { sql += ' AND id = ?'; args.push(String(logId)); }
  else if (batchId) { sql += ' AND batch_id = ?'; args.push(String(batchId)); }
  else if (sinceTs != null && Number.isFinite(Number(sinceTs))) { sql += ' AND ts >= ?'; args.push(Number(sinceTs)); }
  else throw Object.assign(new Error('缺少回滚目标（log_id / batch_id / since_ts）'), { code: 'BAD_TARGET' });
  sql += ' ORDER BY ts DESC, rowid DESC';

  const logs = getDb().prepare(sql).all(...args).map(toLog);
  const applied = [];
  const skipped = [];
  const conflicts = [];
  const pending = [];

  for (const log of logs) {
    if (log.reverted_by) { skipped.push({ log_id: log.id, reason: '已被回滚' }); continue; }
    if (log.entity === 'project' && !log.before) { skipped.push({ log_id: log.id, reason: '项目创建不可回滚（禁止删项目）' }); continue; }
    const d = driftOf(log);
    if (d) conflicts.push({ log_id: log.id, entity: log.entity, entity_id: log.entity_id, action: log.action, current: d.current, expected: d.expected });
    pending.push(log);
  }

  // 先整批预检再动手：避免「改了一半才发现后面冲突」的半吊子状态
  if (conflicts.length && !force) {
    return { applied, skipped, conflicts, blocked: true };
  }

  return withWriteContext('rollback', () => {
    for (const log of pending) {
      const beforeState = rawGet(log.entity, log.entity_id);
      const info = applyInverse(log);
      const afterState = rawGet(log.entity, log.entity_id);
      const rollbackId = recordChange({
        entity: log.entity,
        action: 'rollback',
        before: beforeState,
        after: afterState,
        entityId: log.entity_id,
        revertOf: log.id,
        meta: { inverse: info.inverse, ...(info.chapter_shots_deleted ? { chapter_shots_deleted: info.chapter_shots_deleted } : {}) },
      });
      getDb().prepare('UPDATE change_logs SET reverted_by = ? WHERE id = ?').run(rollbackId || '', log.id);
      applied.push({ log_id: log.id, rollback_log_id: rollbackId, entity: log.entity, entity_id: log.entity_id, inverse: info.inverse, chapter_shots_deleted: info.chapter_shots_deleted || 0, source: log.source, original_action: log.action, ...(info.artifacts && info.artifacts.length ? { warning: '该行含已生成的产物字段（' + info.artifacts.join(', ') + '），磁盘文件未被删除', artifacts: info.artifacts } : {}) });
    }
    return { applied, skipped, conflicts, blocked: false };
  });
}
