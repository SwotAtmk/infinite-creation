// 数据库双驱动：SQLite（免安装、同步）与 PostgreSQL（正式部署）。
//
// 业务层全部是同步调用（db.prepare(...).get/all/run、db.exec、事务），PostgreSQL 的官方
// 驱动是异步的。这里用 worker + Atomics.wait 提供一个**同步门面**，所以 160+ 处 SQL
// 和所有 repository 不需要改成 async。代价是每次查询会阻塞当前进程的事件循环（查询本身
// 很小，Docker 内网延迟通常 <2ms）；如果以后接远程高延迟 PG，应再把 repository 改成 async。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { ROOT, dbSettings } from './config.js';

const WORKER_PATH = path.join(ROOT, 'lib', 'core', 'pg-worker.mjs');

// SQLite 的 ? 占位符转 PostgreSQL 的 $1/$2；跳过字符串、标识符与注释里的问号。
export function toPgSql(sql) {
  const s = String(sql || '');
  let out = '';
  let n = 0;
  let i = 0;
  let quote = '';
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (s[i + 1] === quote) { out += s[i + 1]; i += 2; continue; }
        quote = '';
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '-' && s[i + 1] === '-') {
      const j = s.indexOf('\n', i);
      const end = j < 0 ? s.length : j;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2);
      const end = j < 0 ? s.length : j + 2;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '?') { n += 1; out += '$' + n; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

// SQLite 的 INTEGER 是 64 位、REAL 是 8 字节；PostgreSQL 的 INTEGER/REAL 分别只有 4 字节。
// 时间戳是毫秒（1.7e12），INTEGER 会溢出，所以 DDL 里统一放大。
// 只翻译 DDL，避免误改业务数据里的字符串。
export function translateDdlForPg(sql) {
  const s = String(sql || '');
  if (!/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|UNIQUE\s+INDEX)\b/i.test(s)) return s;
  return s.replace(/\bINTEGER\b/gi, 'BIGINT').replace(/\bREAL\b/gi, 'DOUBLE PRECISION');
}

class SqliteDriver {
  constructor({ path: file }) {
    this.dialect = 'sqlite';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
      run: (...args) => stmt.run(...args),
    };
  }
  exec(sql) { this.db.exec(sql); }
  tableColumns(table) {
    return this.db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name);
  }
  close() { try { this.db.close(); } catch { /* 已关闭 */ } }
}

class PostgresDriver {
  constructor(cfg) {
    this.dialect = 'postgres';
    this.seq = 0;
    this.timeoutMs = 30000;
    this.cfg = cfg;
    this.worker = null;
    this.port = null;
    this.dead = false;
    this._spawn();
  }

  // 创建/重建 worker。数据库连接被重置、worker 崩溃或查询超时后，
  // 下一笔查询会走这里自动恢复；否则主线程会永远卡在 Atomics.wait 的 30s 超时里。
  _spawn() {
    this._terminateWorker();
    const doneSab = new SharedArrayBuffer(4);
    const readySab = new SharedArrayBuffer(4);
    this.done = new Int32Array(doneSab);
    this.ready = new Int32Array(readySab);
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    try { port1.unref(); } catch { /* 旧版本 */ }
    const worker = new Worker(WORKER_PATH, {
      workerData: { config: this.cfg, doneSignal: doneSab, readySignal: readySab, resultPort: port2 },
      transferList: [port2],
    });
    this.worker = worker;
    this.dead = false;
    try { worker.unref(); } catch { /* 旧版本 */ }
    // worker 崩溃/退出时唤醒正在等待的主线程，避免白等满 30 秒。
    const wake = () => {
      if (this.worker !== worker) return;
      this.dead = true;
      Atomics.store(this.done, 0, 1);
      Atomics.notify(this.done, 0);
      Atomics.store(this.ready, 0, 2);
      Atomics.notify(this.ready, 0);
    };
    worker.on('error', wake);
    worker.on('exit', wake);
    const status = Atomics.wait(this.ready, 0, 0, 15000);
    if (status === 'timed-out') {
      this._terminateWorker();
      throw new Error('PostgreSQL 连接超时（15s）：请检查 DATABASE_URL / 网络 / 数据库是否已启动');
    }
    if (Atomics.load(this.ready, 0) !== 1) {
      let msg = null;
      for (let i = 0; i < 2000 && !msg; i++) {
        msg = receiveMessageOnPort(this.port)?.message;
        if (!msg) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
      const detail = msg?.startupError?.message || (Atomics.load(this.ready, 0) === 2 ? 'worker 启动失败' : '未知错误');
      this._terminateWorker();
      throw new Error('PostgreSQL 连接失败：' + detail);
    }
  }

  _terminateWorker() {
    const worker = this.worker;
    this.worker = null;
    this.dead = true;
    if (worker) {
      try { worker.terminate(); } catch { /* 已退出 */ }
    }
    if (this.port) {
      try { this.port.close(); } catch { /* 已关闭 */ }
      this.port = null;
    }
  }

  call(kind, sql, params = []) {
    // 上一次查询超时/worker 崩溃后，先重建再发；重建失败会抛错，但不会永久卡死。
    if (this.dead || !this.worker) this._spawn();
    const id = ++this.seq;
    const text = translateDdlForPg(toPgSql(sql));
    const values = (params || []).map((v) => (v === undefined ? null : v));
    Atomics.store(this.done, 0, 0);
    this.worker.postMessage({ id, kind, sql: text, params: values });
    const status = Atomics.wait(this.done, 0, 0, this.timeoutMs);
    if (status === 'timed-out') {
      this._terminateWorker();
      throw Object.assign(new Error('PostgreSQL 查询超时（' + this.timeoutMs + 'ms）'), { code: 'PG_TIMEOUT' });
    }
    let msg;
    for (let i = 0; i < 2000 && !msg; i++) {
      msg = receiveMessageOnPort(this.port)?.message;
      if (!msg) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
    if (!msg) {
      this._terminateWorker();
      throw new Error('PostgreSQL 查询结果读取失败');
    }
    if (!msg.ok) {
      const e = new Error(msg.error?.message || ('PostgreSQL 查询失败：' + JSON.stringify(msg)));
      e.code = msg.error?.code;
      e.detail = msg.error?.detail;
      e.constraint = msg.error?.constraint;
      throw e;
    }
    return msg.payload;
  }
  prepare(sql) {
    return {
      get: (...args) => this.call('get', sql, args),
      all: (...args) => this.call('all', sql, args),
      run: (...args) => this.call('run', sql, args),
    };
  }
  exec(sql) { this.call('exec', sql, []); }
  tableColumns(table) {
    return this.call(
      'all',
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
      [table],
    ).map((r) => r.name);
  }
  close() {
    this._terminateWorker();
  }
}

export function createDb(settings = dbSettings()) {
  return settings.provider === 'postgres'
    ? new PostgresDriver(settings.postgres)
    : new SqliteDriver({ path: settings.sqlitePath });
}
