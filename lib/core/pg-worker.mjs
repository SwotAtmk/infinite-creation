// PostgreSQL worker：主线程通过 Atomics.wait 同步等待这里的结果。
// 一次只处理一条查询（主线程本来就是串行的），事务状态因此保持在同一条连接上。
//
// 连接必须自己兜底：pg.Client 是 EventEmitter，连接被数据库/网络重置时如果没有
// 'error' 监听器，Node 会把 'read ECONNRESET' 当成 uncaughtException，worker 线程直接死掉；
// 主线程随后每一笔查询都等到 30s 超时，事件循环被 Atomics.wait 卡死，整个后端失联。
// 这里统一做：监听 error、查询失败识别连接错误、下一条查询自动重连。
import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';

const { config, doneSignal, readySignal, resultPort } = workerData;
const done = new Int32Array(doneSignal);
const ready = new Int32Array(readySignal);

// BIGINT / NUMERIC 默认被 pg 解析成字符串；项目把它们当数字用（计数、金额、时间戳）。
pg.types.setTypeParser(20, (v) => (v == null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));

const clientConfig = config.url
  ? { connectionString: config.url, ssl: config.ssl || undefined, connectionTimeoutMillis: 10000 }
  : {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: config.ssl || undefined,
      connectionTimeoutMillis: 10000,
    };

let client = null;
let connecting = null;

function isConnectionError(e) {
  const code = String((e && e.code) || '');
  const msg = String((e && e.message) || '');
  return [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
    '08000', '08001', '08003', '08004', '08006', '57P01', '57P02', '57P03',
  ].includes(code) || /Connection terminated|connection error|not queryable|socket hang up/i.test(msg);
}

function createClient() {
  const c = new pg.Client(clientConfig);
  // 关键：没有这个监听器，连接错误会变成 worker 的 uncaughtException。
  c.on('error', () => {
    if (client === c) client = null;
  });
  c.on('end', () => {
    if (client === c) client = null;
  });
  return c;
}

async function ensureClient() {
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      const c = createClient();
      await c.connect();
      client = c;
      return c;
    })();
    // 让下一笔查询可以重新尝试；当前等待者仍会收到原始错误。
    connecting.finally(() => { connecting = null; }).catch(() => {});
  }
  return connecting;
}

function resetClient(c) {
  if (client === c) client = null;
  try { c?.end(); } catch { /* 已断开 */ }
}

ensureClient()
  .then(() => {
    Atomics.store(ready, 0, 1);
    Atomics.notify(ready, 0);
  })
  .catch((e) => {
    resultPort.postMessage({ startupError: { message: e.message, code: e.code } });
    Atomics.store(ready, 0, 2);
    Atomics.notify(ready, 0);
  });

parentPort.on('message', async (msg) => {
  try {
    const c = await ensureClient();
    // 无参数时走 simple query，允许 db.exec() 里一次执行多条 DDL；
    // 有参数时走 extended protocol（单条语句、$n 占位符）。
    let res;
    try {
      res = msg.params && msg.params.length
        ? await c.query({ text: msg.sql, values: msg.params })
        : await c.query(msg.sql);
    } catch (e) {
      if (isConnectionError(e)) resetClient(c);
      throw e;
    }
    let payload;
    if (msg.kind === 'get') payload = Array.isArray(res) ? (res[0]?.rows?.[0] ?? null) : (res.rows[0] ?? null);
    else if (msg.kind === 'all') payload = Array.isArray(res) ? (res[res.length - 1]?.rows || []) : res.rows;
    else payload = { changes: Array.isArray(res) ? 0 : (res.rowCount || 0) };
    resultPort.postMessage({ id: msg.id, ok: true, payload });
  } catch (e) {
    resultPort.postMessage({
      id: msg.id,
      ok: false,
      error: { message: e.message, code: e.code, detail: e.detail, constraint: e.constraint },
    });
  } finally {
    Atomics.store(done, 0, 1);
    Atomics.notify(done, 0);
  }
});
