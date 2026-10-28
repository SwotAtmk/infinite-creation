#!/usr/bin/env node
// 一键把现有数据库迁移到 Docker 部署使用的数据库。
//
// 用法：
//   node scripts/docker-migrate.mjs --from sqlite --to postgres
//   node scripts/docker-migrate.mjs --from postgres --to sqlite
//   node scripts/docker-migrate.mjs --from postgres --to postgres --from-url postgres://...
//   node scripts/docker-migrate.mjs --from sqlite --to sqlite
//
// 说明：
// - 媒体文件（data/projects）不经过数据库；Docker 里通过 ./data:/data 挂载，
//   迁移后继续使用同一个目录即可。
// - 默认使用 docker-compose.yml（PostgreSQL）作为运行迁移的容器；
//   目标为 SQLite 时，迁移文件写入宿主机 ./data/ic.db。
// - 源 PostgreSQL 在宿主机上时，URL 里的 127.0.0.1 要换成 host.docker.internal
//   （compose 已为 app 配置 extra_hosts）。
// - 先备份！--replace 会清空目标表后重写。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

function usage() {
  console.log(`用法：
  node scripts/docker-migrate.mjs --from <sqlite|postgres> --to <sqlite|postgres> [选项]

选项：
  --from <sqlite|postgres>   源数据库类型（必填）
  --to   <sqlite|postgres>   目标数据库类型（必填）
  --sqlite <path>            宿主机 SQLite 文件，默认 data/ic.db
  --from-url <url>           源 PostgreSQL 连接串（from=postgres 时使用）
  --to-url <url>             目标 PostgreSQL 连接串（默认使用 compose 的 DATABASE_URL）
  --compose <file>           使用的 compose 文件，默认 docker-compose.yml
  --replace                  清空目标表后重写（默认按主键 upsert）
  --no-build                 不重新构建 app 镜像
  --dry-run                  只打印将执行的命令
  --help                     显示本帮助

示例：
  # 本地 SQLite -> Docker PostgreSQL
  node scripts/docker-migrate.mjs --from sqlite --to postgres

  # 本机现有 PostgreSQL -> Docker PostgreSQL
  node scripts/docker-migrate.mjs --from postgres --to postgres \\
    --from-url 'postgres://ic:密码@host.docker.internal:55432/infinite_creation'

  # Docker PostgreSQL -> 宿主机 SQLite（给 SQLite compose 用）
  node scripts/docker-migrate.mjs --from postgres --to sqlite

  # 本地 SQLite -> 另一个 SQLite 文件
  node scripts/docker-migrate.mjs --from sqlite --to sqlite --sqlite data/ic.db
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--replace') { out.replace = true; continue; }
    if (a === '--no-build') { out.noBuild = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (['--from', '--to', '--sqlite', '--from-url', '--to-url', '--compose'].includes(a)) {
      out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
      continue;
    }
    throw new Error('未知参数：' + a);
  }
  return out;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  usage();
  process.exit(1);
}
if (args.help) { usage(); process.exit(0); }
if (!args.from || !args.to) { usage(); process.exit(1); }
const from = String(args.from).toLowerCase();
const to = String(args.to).toLowerCase();
if (!['sqlite', 'postgres'].includes(from) || !['sqlite', 'postgres'].includes(to)) {
  console.error('--from / --to 只能是 sqlite 或 postgres');
  process.exit(1);
}

const sqliteAbs = path.resolve(args.sqlite || path.join(DATA_DIR, 'ic.db'));
const compose = path.resolve(args.compose || path.join(ROOT, 'docker-compose.yml'));
const service = 'app';
const dryRun = !!args.dryRun;
const build = !args.noBuild;

function run(cmd, argv, opts = {}) {
  const line = [cmd, ...argv].map((x) => (String(x).includes(' ') ? JSON.stringify(x) : x)).join(' ');
  console.log('$ ' + line);
  if (dryRun) return { status: 0 };
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', env: process.env, ...opts });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status || 1);
  return r;
}

function composeRun(sqliteContainerPath, { rw = false } = {}) {
  const argv = ['compose', '-f', compose, 'run', '--rm', '--no-deps'];
  if (build) argv.push('--build');
  // 如果 SQLite 不在 ./data 下，单独挂载它的目录
  if (sqliteContainerPath && sqliteContainerPath.startsWith('/import/')) {
    const hostDir = path.dirname(sqliteAbs).replace(/\\/g, '/');
    argv.push('-v', hostDir + ':/import' + (rw ? '' : ':ro'));
  }
  argv.push(service, 'node', 'scripts/db-migrate.mjs');
  return argv;
}

function insideData(p) {
  const rel = path.relative(DATA_DIR, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function containerPath(p) {
  if (insideData(p)) return '/data/' + path.relative(DATA_DIR, p).split(path.sep).join('/');
  return '/import/' + path.basename(p);
}

function ensureHostData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function backupSqlite(p) {
  if (!fs.existsSync(p)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = p + '.bak-' + stamp;
  fs.copyFileSync(p, bak);
  console.log('已备份 SQLite：' + bak);
}

function startDbIfNeeded() {
  // db 服务带 profiles: ["postgres"]；显式 --profile postgres + 指定 db 服务，
  // 即使 .env 当前是 SQLite 模式也能临时拉起 PostgreSQL 用于迁移。
  run('docker', ['compose', '-f', compose, '--profile', 'postgres', 'up', '-d', '--wait', 'db']);
}

async function main() {
  ensureHostData();
  console.log('迁移方向：' + from + ' -> ' + to);
  console.log('SQLite 文件：' + sqliteAbs);
  console.log('Compose：' + compose);

  if (from === 'sqlite' && to === 'sqlite') {
    if (!fs.existsSync(sqliteAbs)) {
      console.error('源 SQLite 不存在：' + sqliteAbs);
      process.exit(1);
    }
    const target = path.resolve(args.toUrl || path.join(DATA_DIR, 'ic.db'));
    if (target === sqliteAbs) {
      console.error('源和目标 SQLite 是同一个文件：' + target);
      process.exit(1);
    }
    backupSqlite(target);
    console.log('复制 ' + sqliteAbs + ' -> ' + target);
    if (!dryRun) fs.copyFileSync(sqliteAbs, target);
    console.log('完成。媒体文件请继续使用 data/projects。');
    return;
  }

  if (from === 'sqlite' && to === 'postgres') {
    if (!fs.existsSync(sqliteAbs)) {
      console.error('源 SQLite 不存在：' + sqliteAbs);
      process.exit(1);
    }
    startDbIfNeeded();
    const cPath = containerPath(sqliteAbs);
    const argv = composeRun(cPath, { rw: false });
    argv.push('--from', 'sqlite', '--to', 'postgres', '--from-sqlite', cPath);
    if (args.replace) argv.push('--replace');
    if (args.toUrl) argv.push('--to-url', args.toUrl);
    run('docker', argv);
    console.log('完成。媒体文件不迁移，Docker 继续挂载 ./data:/data。');
    return;
  }

  if (from === 'postgres' && to === 'sqlite') {
    backupSqlite(sqliteAbs);
    startDbIfNeeded();
    const cPath = containerPath(sqliteAbs);
    const argv = composeRun(cPath, { rw: true });
    argv.push('--from', 'postgres', '--to', 'sqlite', '--to-sqlite', cPath);
    if (args.replace) argv.push('--replace');
    if (args.fromUrl) argv.push('--from-url', args.fromUrl);
    run('docker', argv);
    console.log('完成。启动 SQLite compose：docker compose -f docker-compose.sqlite.yml up -d --build');
    return;
  }

  if (from === 'postgres' && to === 'postgres') {
    if (!args.fromUrl) {
      console.error('postgres -> postgres 需要 --from-url（源库连接串）');
      process.exit(1);
    }
    startDbIfNeeded();
    const argv = composeRun(null);
    argv.push('--from', 'postgres', '--to', 'postgres', '--from-url', args.fromUrl);
    if (args.replace) argv.push('--replace');
    if (args.toUrl) argv.push('--to-url', args.toUrl);
    run('docker', argv);
    console.log('完成。');
    return;
  }

  console.error('不支持的迁移方向：' + from + ' -> ' + to);
  process.exit(1);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
