#!/usr/bin/env node
// 数据库迁移 / 同步：SQLite ⇄ PostgreSQL，表结构与应用完全一致（复用 initSchema）。
//
// 常用：
//   node scripts/db-migrate.mjs --from sqlite --to postgres --to-url postgres://user:pass@host:5432/db
//   node scripts/db-migrate.mjs --from postgres --to sqlite --from-url postgres://... --to-sqlite data/ic-pg.db
//
// 默认：from=sqlite（data/ic.db），to=postgres（DATABASE_URL）。
// --replace 会先清空目标表再写入；默认按主键 upsert（可重复执行，不删目标多余行）。
// 媒体文件不经过数据库：图片/视频都在 IC_MEDIA_DIR（默认 <data>/projects），迁移后继续用同一个目录/挂载卷即可。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../lib/core/db-driver.js';
import { initSchema } from '../lib/core/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TABLES = [
  'projects', 'chapters',
  'assets', 'shots', 'jobs', 'queue_items',
  'skills', 'workflows', 'messages', 'reference_images', 'change_logs',
];

function parseArgs(argv) {
  const out = { replace: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--replace') { out.replace = true; continue; }
    if (a === '--ssl') { out.ssl = true; continue; }
    if (a === '--from' || a === '--to' || a === '--from-sqlite' || a === '--to-sqlite' || a === '--from-url' || a === '--to-url') {
      out[a.slice(2)] = argv[++i];
      continue;
    }
    console.error('未知参数：' + a);
    process.exit(1);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const fromProvider = String(args.from || 'sqlite').toLowerCase() === 'postgres' ? 'postgres' : 'sqlite';
const toProvider = String(args.to || 'postgres').toLowerCase() === 'postgres' ? 'postgres' : 'sqlite';
const defaultSqlite = process.env.IC_DB_SQLITE_PATH || path.join(ROOT, 'data', 'ic.db');
const fromSqlite = path.resolve(args['from-sqlite'] || defaultSqlite);
const toSqlite = path.resolve(args['to-sqlite'] || defaultSqlite);
const fromUrl = args['from-url'] || process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL || '';
const toUrl = args['to-url'] || process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL || '';

if (fromProvider === toProvider && fromProvider === 'sqlite' && fromSqlite === toSqlite) {
  console.error('源和目标都是同一个 SQLite 文件：' + fromSqlite);
  process.exit(1);
}
if (fromProvider === 'postgres' && !fromUrl) {
  console.error('--from postgres 需要 --from-url 或 SOURCE_DATABASE_URL / DATABASE_URL');
  process.exit(1);
}
if (toProvider === 'postgres' && !toUrl) {
  console.error('--to postgres 需要 --to-url 或 TARGET_DATABASE_URL / DATABASE_URL');
  process.exit(1);
}

function makeSettings(provider, sqlitePath, url) {
  return {
    provider,
    sqlitePath,
    postgres: {
      url,
      host: '127.0.0.1', port: 5432, user: '', password: '', database: '',
      ssl: args.ssl ? { rejectUnauthorized: false } : false,
    },
  };
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function upsertSql(dialect, table, cols, pk = 'id') {
  const names = cols.map(quoteIdent).join(',');
  const marks = cols.map(() => '?').join(',');
  if (dialect === 'postgres') {
    const updates = cols.filter((c) => c !== pk).map((c) => quoteIdent(c) + ' = EXCLUDED.' + quoteIdent(c)).join(', ');
    return 'INSERT INTO ' + quoteIdent(table) + ' (' + names + ') VALUES (' + marks + ') ON CONFLICT (' + quoteIdent(pk) + ') DO ' + (updates ? 'UPDATE SET ' + updates : 'NOTHING');
  }
  return 'INSERT OR REPLACE INTO ' + quoteIdent(table) + ' (' + names + ') VALUES (' + marks + ')';
}

function tableExists(db, table) {
  try {
    return db.tableColumns(table).length > 0;
  } catch {
    return false;
  }
}

console.log('数据库迁移：' + fromProvider + ' → ' + toProvider);
if (fromProvider === 'sqlite') console.log('  源 SQLite：' + fromSqlite);
else console.log('  源 PostgreSQL：' + (fromUrl ? '<url>' : '(未设置)'));
if (toProvider === 'sqlite') console.log('  目标 SQLite：' + toSqlite);
else console.log('  目标 PostgreSQL：' + (toUrl ? '<url>' : '(未设置)'));

const source = createDb(makeSettings(fromProvider, fromSqlite, fromUrl));
let target;
try {
  target = createDb(makeSettings(toProvider, toSqlite, toUrl));
  initSchema(target);
} catch (e) {
  source.close?.();
  console.error('目标数据库初始化失败：' + e.message);
  process.exit(1);
}

let totalRows = 0;
let failures = 0;
try {
  for (const table of TABLES) {
    if (!tableExists(source, table)) {
      console.log('  跳过 ' + table + '（源库没有该表）');
      continue;
    }
    const srcCols = source.tableColumns(table);
    const tgtCols = target.tableColumns(table);
    if (!tgtCols.length) {
      console.log('  跳过 ' + table + '（目标库没有该表）');
      continue;
    }
    const tgtSet = new Set(tgtCols);
    const cols = srcCols.filter((c) => tgtSet.has(c));
    const pk = 'id';
    if (!cols.some((c) => c === pk)) {
      console.log('  跳过 ' + table + '（没有 ' + pk + ' 主键，无法 upsert）');
      continue;
    }
    if (args.replace) {
      try { target.exec('DELETE FROM ' + quoteIdent(table)); } catch (e) { console.error('  清空 ' + table + ' 失败：' + e.message); failures++; }
    }
    const rows = source.prepare('SELECT * FROM ' + quoteIdent(table)).all();
    const sql = upsertSql(target.dialect, table, cols, pk);
    const stmt = target.prepare(sql);
    let ok = 0;
    target.exec('BEGIN');
    try {
      for (const row of rows) {
        stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
        ok++;
      }
      target.exec('COMMIT');
    } catch (e) {
      try { target.exec('ROLLBACK'); } catch {}
      console.error('  写入 ' + table + ' 失败（已回滚本表）：' + e.message);
      failures++;
      continue;
    }
    totalRows += ok;
    console.log('  ' + table + '：' + ok + ' 行');
  }
} finally {
  source.close?.();
  target.close?.();
}

console.log('');
console.log(failures ? '完成，但有 ' + failures + ' 张表失败' : '完成');
console.log('总写入 ' + totalRows + ' 行。');
console.log('媒体文件未迁移：它们不在数据库里，继续使用同一个 IC_MEDIA_DIR（默认 <data>/projects）目录或 Docker 挂载卷即可。');
console.log('');
console.log('切换方式：');
console.log('  SQLite     ：IC_DB=sqlite IC_DB_SQLITE_PATH=' + fromSqlite);
console.log('  PostgreSQL ：IC_DB=postgres DATABASE_URL=<目标连接串>');
process.exit(failures ? 1 : 0);
