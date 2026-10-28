// 渲染队列调度器（只对 RunningHub 云端模式生效；本地 ComfyUI 仍由 job-runner 的整批串行闸门控制）。
//
// 解决的问题：一个 RunningHub 账号只有 N 个并发，但可能有多个用户同时提交成百上千个渲染任务。
// 如果按提交顺序 FIFO，一个人批量提交就会把后面所有人堵死。这里按「用户」公平发牌：
//   1. 全局只有 capacity 个槽位，槽位空出来才派下一个（不是等整条流水线跑完）；
//   2. 每条 = 一次真正的生成（出图/出视频/TTS/音乐），流水线的 LLM 阶段不占槽；
//   3. 用户之间轮转（Deficit Round Robin），单用户动态上限 = ceil(容量 / 在线用户数)；
//   4. 池子有保底（图片/视频各 1 个），不用的保留槽会自动借给有积压的池（work-conserving）；
//   5. 等待超过 agingMinutes 的任务自动提权，防止被后来者无限插队。
//
// 调度状态挂在 globalThis：Next.js（含 dev）会为不同 route 各打包一份本模块，
// 模块级 Map 会让两个入口各自以为自己才是调度器（同 job-runner 里 abortFlags 的坑）。
import { Queue, Jobs, Projects, WalletHolds } from './db.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { sleep, uid } from './utils.js';
import {
  checkBalance, checkQuota, priceForKind, recordUsage, retryPendingReports,
  captureHold, holdCredits, releaseHold, walletEnabled,
} from './billing.js';

const G = (globalThis.__icRenderQueue = globalThis.__icRenderQueue || {
  // 进程级 worker 标识：多个后端（4610 Studio / 4600 经典）共享同一个 DB 时，
  // 各自只派发自己入队的条目，互不抢占。
  workerId: 'w-' + process.pid + '-' + Math.random().toString(36).slice(2, 8),
  waiters: new Map(), // queueItemId -> { resolve, reject }
  lastServed: new Map(), // ownerId -> 上次拿到槽位的时间
  timer: null,
  started: false,
  pokeScheduled: false,
  pausedUntil: 0,
  pauseReason: '',
});

// —— 配置解析：每次 tick 重新读，改 config.json 立即生效（不用重启） ——
export function queueSettings(cfg) {
  cfg = cfg || loadConfig();
  const g = cfg?.generation || {};
  const q = g.queue || {};
  const pools = {};
  for (const [k, v] of Object.entries(q.pools || {})) {
    pools[k] = { min: Math.max(0, Number(v?.min) || 0), max: Math.max(0, Number(v?.max) || 0) };
  }
  if (!Object.keys(pools).length) pools.render = { min: 0, max: 0 };
  return {
    enabled: q.enabled !== false,
    capacity: Math.max(1, Number(q.capacity) || Number(g.runninghubConcurrency) || 1),
    perUserConcurrency: Math.max(0, Number(q.perUserConcurrency) || 0), // 0 = 只按动态份额
    perUserMaxWaiting: Math.max(1, Number(q.perUserMaxWaiting) || 50),
    queueTimeoutMs: Math.max(1, Number(q.queueTimeoutMinutes) || 120) * 60000,
    agingMs: Math.max(0, Number(q.agingMinutes ?? 15)) * 60000,
    tickMs: Math.max(100, Number(q.tickMs) || 500),
    leaseMs: Math.max(1, Number(q.leaseMinutes) || 30) * 60000,
    retryTimes: Math.max(0, Number(q.retryTimes ?? g.retryTimes) || 0),
    pauseMs: Math.max(0, Number(q.pauseOnQuotaErrorMinutes ?? 10)) * 60000,
    pools,
  };
}

export function queueEnabled(cfg) {
  // 应急开关：IC_QUEUE=0 时强制回到旧的「整批串行闸门」，用于本地 ComfyUI 或线上排障。
  if (process.env.IC_QUEUE === '0') return false;
  cfg = cfg || loadConfig();
  return cfg?.comfyui?.provider === 'runninghub' && queueSettings(cfg).enabled;
}

export function poolOfKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 't2i' || k === 'i2i' || k === 'image') return 'image';
  if (k === 'r2v' || k === 'i2v' || k === 'video') return 'video';
  if (k === 'tts' || k === 'voice' || k === 'audio') return 'tts';
  if (k === 'music') return 'music';
  return 'render';
}


/**
 * 纯函数：给定「正在跑 + 排队中」的快照，算出这一轮该派发哪些排队条目。
 * 抽成纯函数是为了能直接单测公平性（见 tests/queue-scheduler.test.mjs）。
 */
export function planDispatch({
  waiting = [],
  running = [],
  capacity = 1,
  perUserConcurrency = 0,
  pools = {},
  agingMs = 0,
  at = Date.now(),
  lastServed = new Map(),
} = {}) {
  const picked = [];
  if (!waiting.length || capacity <= 0) return picked;

  const runningByOwner = new Map();
  const runningByPool = new Map();
  for (const r of running) {
    const o = r.ownerId || '';
    const p = r.pool || 'render';
    runningByOwner.set(o, (runningByOwner.get(o) || 0) + 1);
    runningByPool.set(p, (runningByPool.get(p) || 0) + 1);
  }
  const takenByOwner = new Map();
  const takenByPool = new Map();
  let slots = Math.max(0, capacity - running.length);

  const owners = new Set();
  for (const x of running) owners.add(x.ownerId || '');
  for (const x of waiting) owners.add(x.ownerId || '');
  const share = Math.max(1, Math.ceil(capacity / Math.max(1, owners.size)));
  const cap = perUserConcurrency > 0 ? Math.max(1, Math.min(perUserConcurrency, share)) : share;

  const effPriority = (w) => (Number(w.priority) || 0) + (agingMs > 0 && at - (w.enqueuedAt || 0) >= agingMs ? 1 : 0);
  const byOwner = new Map();
  for (const w of waiting) {
    const o = w.ownerId || '';
    if (!byOwner.has(o)) byOwner.set(o, []);
    byOwner.get(o).push(w);
  }
  for (const arr of byOwner.values()) {
    arr.sort((a, b) => effPriority(b) - effPriority(a) || (a.seq || 0) - (b.seq || 0));
  }

  const userRoom = (o) => cap - ((runningByOwner.get(o) || 0) + (takenByOwner.get(o) || 0));
  const poolRoom = (p) => {
    const max = Number(pools?.[p]?.max) || 0;
    if (!max) return Infinity;
    return max - ((runningByPool.get(p) || 0) + (takenByPool.get(p) || 0));
  };
  const take = (owner, w) => {
    picked.push(w);
    takenByOwner.set(owner, (takenByOwner.get(owner) || 0) + 1);
    const p = w.pool || 'render';
    takenByPool.set(p, (takenByPool.get(p) || 0) + 1);
    slots--;
  };
  // 在某个池里挑一个「该池还有余量、该用户还有额度」的任务：
  // 先比有效优先级（含 aging），再比「本 tick 已经拿过几次」（保证轮转），最后比上次服务时间。
  const better = (owner, cand, cur) => {
    if (!cur) return true;
    if (cand.pri !== cur.pri) return cand.pri > cur.pri;
    const took = takenByOwner.get(owner) || 0;
    if (took !== cur.took) return took < cur.took;
    return (lastServed.get(owner) || 0) < cur.at;
  };
  const pickFiltered = (pool) => {
    let best = null;
    for (const [owner, arr] of byOwner) {
      if (userRoom(owner) <= 0) continue;
      const idx = arr.findIndex((w) => (w.pool || 'render') === pool && poolRoom(w.pool || 'render') > 0);
      if (idx < 0) continue;
      const cand = { owner, idx, pri: effPriority(arr[idx]), took: takenByOwner.get(owner) || 0, at: lastServed.get(owner) || 0 };
      if (better(owner, cand, best)) best = cand;
    }
    return best;
  };

  // 第一轮：满足各池保底（有积压的池至少先拿一个槽）
  for (const [pool, conf] of Object.entries(pools)) {
    const min = Number(conf?.min) || 0;
    while (min > 0 && slots > 0) {
      const used = (runningByPool.get(pool) || 0) + (takenByPool.get(pool) || 0);
      if (used >= min) break;
      const hit = pickFiltered(pool);
      if (!hit) break;
      take(hit.owner, byOwner.get(hit.owner).splice(hit.idx, 1)[0]);
    }
  }

  // 第二轮：剩余槽位按用户轮转（优先级 → 本 tick 次数 → 上次服务时间）
  while (slots > 0) {
    let best = null;
    for (const [owner, arr] of byOwner) {
      if (!arr.length || userRoom(owner) <= 0) continue;
      const idx = arr.findIndex((w) => poolRoom(w.pool || 'render') > 0);
      if (idx < 0) continue;
      const cand = { owner, idx, pri: effPriority(arr[idx]), took: takenByOwner.get(owner) || 0, at: lastServed.get(owner) || 0 };
      if (better(owner, cand, best)) best = cand;
    }
    if (!best) break;
    take(best.owner, byOwner.get(best.owner).splice(best.idx, 1)[0]);
  }

  return picked;
}

// —— 调度循环 ——
function tick() {
  const cfg = loadConfig();
  const s = queueSettings(cfg);
  if (!s.enabled || cfg?.comfyui?.provider !== 'runninghub') return;
  const at = Date.now();
  if (G.pausedUntil > at) return;

  // 执行中心跳中断的条目：本进程还有 waiter 说明只是事件循环卡了一下，续租即可；
  // 没有 waiter 才是真失联，直接判失败（绝不重新排队——重放会重复提交渲染）。
  for (const item of Queue.staleRunning(at, G.workerId)) {
    if (G.waiters.has(item.id)) {
      Queue.touch(item.id, s.leaseMs);
    } else {
      Queue.fail(item.id, '执行器失联，任务已终止');
      logger.warn('队列任务执行器失联，已终止', { id: item.id, pool: item.pool });
    }
  }

  // 容量与用户份额按**全局**在跑任务算（多进程共享同一个 RunningHub 账号，各进程的槽位加起来不能超）；
  // 但只派发本进程入队的条目（别的进程的 waiter 在本进程里不存在）。
  const running = Queue.running();
  const waiting = Queue.waiting(at, G.workerId);
  if (!waiting.length) return;

  const picked = planDispatch({
    waiting,
    running,
    capacity: s.capacity,
    perUserConcurrency: s.perUserConcurrency,
    pools: s.pools,
    agingMs: s.agingMs,
    at,
    lastServed: G.lastServed,
  });

  for (const item of picked) {
    const w = G.waiters.get(item.id);
    if (!w) {
      // 没有执行器接管（例如条目是别的进程遗留的）：不占槽位
      Queue.fail(item.id, '没有执行器接管');
      continue;
    }
    if (!Queue.claim(item.id, s.leaseMs)) continue; // 已被其它入口领走
    G.waiters.delete(item.id);
    G.lastServed.set(item.ownerId || '', at);
    w.resolve();
  }
}

export function poke() {
  if (G.pokeScheduled) return;
  G.pokeScheduled = true;
  setImmediate(() => {
    G.pokeScheduled = false;
    try {
      tick();
    } catch (e) {
      logger.warn('渲染队列调度失败：' + (e && e.message));
    }
  });
}

export function startScheduler() {
  if (G.started) return;
  G.started = true;
  const s = queueSettings();
  G.timer = setInterval(() => {
    try {
      tick();
    } catch (e) {
      logger.warn('渲染队列调度失败：' + (e && e.message));
    }
  }, s.tickMs);
  if (G.timer.unref) G.timer.unref();
  // 用量回传重试：与队列无关，每分钟跑一次（失败按 1/2/4/8/16 分钟退避）
  if (!G.reportTimer) {
    G.reportTimer = setInterval(() => {
      retryPendingReports(loadConfig()).catch(() => {});
      // 预授权兜底：进程异常退出留下的 hold 到期自动退回，避免余额被永久占住
      try { WalletHolds.releaseExpired(); } catch {}
    }, 60_000);
    if (G.reportTimer.unref) G.reportTimer.unref();
  }
  logger.info('渲染队列调度器已启动：全局 ' + s.capacity + ' 槽，单用户上限 '
    + (s.perUserConcurrency > 0 ? s.perUserConcurrency : '动态（按在线人数）')
    + '，池 ' + Object.keys(s.pools).join('/'));
  poke();
}

export function stopScheduler() {
  if (G.timer) clearInterval(G.timer);
  if (G.reportTimer) clearInterval(G.reportTimer);
  G.timer = null;
  G.reportTimer = null;
  G.started = false;
}

// 暂停派发（RunningHub 余额不足/并发超限时用）：队列保持 waiting，不丢任务
export function pauseQueue(ms, reason = '') {
  const until = Date.now() + Math.max(0, ms);
  if (until > G.pausedUntil) {
    G.pausedUntil = until;
    G.pauseReason = reason;
    logger.warn('渲染队列已暂停 ' + Math.round(ms / 60000) + ' 分钟：' + reason);
  }
}

export function resumeQueue() {
  G.pausedUntil = 0;
  G.pauseReason = '';
  poke();
}

const QUOTA_ERROR = /余额|点数|额度|并发.*(超|限制)|quota|balance|rate limit|too many/i;
const RETRYABLE_ERROR = /timeout|timed out|超时|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|HTTP 5\d\d|502|503|504/i;
const NON_RETRYABLE = /内容|违规|审核|参数|非法|未就绪|余额|额度|不支持|invalid|unauthorized|401|403/i;

export function isRetryableError(e) {
  const msg = String((e && e.message) || e || '');
  if (NON_RETRYABLE.test(msg)) return false;
  return RETRYABLE_ERROR.test(msg);
}

function noteQuotaError(e) {
  // 本地钱包“某个用户积分不足”不是上游配额/并发故障，不能因此暂停全局队列影响其他用户
  if (e && e.code === 'INSUFFICIENT_CREDITS') return;
  const msg = String((e && e.message) || e || '');
  if (!QUOTA_ERROR.test(msg)) return;
  const s = queueSettings();
  pauseQueue(s.pauseMs, msg.slice(0, 200));
}

// —— 执行侧：拿槽位 → 执行 → 归还 ——
function waitForGrant(itemId, { waitMax, isAborted }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let watch = null;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (watch) clearInterval(watch);
      G.waiters.delete(itemId);
      fn(arg);
    };
    timer = setTimeout(() => done(reject, new Error('等待渲染槽位超时（' + Math.round(waitMax / 60000) + ' 分钟），已放弃')), waitMax);
    // 排队期间也要响应停止按钮：不能等它「轮到自己」才发现已经不需要跑了
    watch = setInterval(() => {
      if (isAborted && isAborted()) done(reject, new Error('任务已停止（排队中）'));
    }, 2000);
    if (timer.unref) timer.unref();
    if (watch.unref) watch.unref();
    // 先登记再触发调度，避免刚入队就被派发却找不到 waiter
    G.waiters.set(itemId, {
      resolve: () => done(resolve),
      reject: (e) => done(reject, e),
    });
    poke();
  });
}

/**
 * 在队列里执行一次渲染。签名保持简单，runWorkflow / job-runner 都走它。
 * opts: { jobId, projectId, ownerId, pool, kind, isAborted, onQueue, waitMaxMs, maxAttempts, payload }
 */
export async function runInQueue(opts, fn) {
  // 惰性启动：任何进程只要真的入队，就必须有人在发牌。
  // 只依赖 server.js 启动会在「脚本 / 测试 / 其他入口直接调用工具」时把任务挂死在队列里。
  if (!G.started) startScheduler();
  const cfg = loadConfig();
  const s = queueSettings(cfg);
  const jobId = opts.jobId || '';
  const projectId = opts.projectId || (jobId ? Jobs.get(jobId)?.projectId || '' : '');
  const ownerId = opts.ownerId || (projectId ? Projects.ownerOf(projectId) || '' : '');
  const pool = opts.pool || 'render';
  const kind = opts.kind || '';
  const quantity = Math.max(1, Number(opts.quantity) || 1);
  const price = priceForKind(cfg, kind, quantity);
  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || s.retryTimes + 1);
  const waitMax = Math.max(1000, Number(opts.waitMaxMs) || s.queueTimeoutMs);

  // 本地钱包开启时：提交前先预授权（立即从余额扣除），成功 capture、失败 release。
  // 没开钱包时保持原来的父平台余额校验 + 后付费。
  const useWallet = walletEnabled(cfg) && !!ownerId && price.amount > 0;
  let hold = null;
  if (useWallet) {
    hold = holdCredits({
      ownerId,
      amount: price.amount,
      key: 'render:' + uid(),
      jobId,
      projectId,
      kind,
      chapter: opts.chapter || '',
      subject: opts.subject || '',
      ttlMs: Math.max(60 * 60 * 1000, Number(cfg.billing?.wallet?.holdTtlMinutes || 2880) * 60 * 1000),
    }, cfg);
  } else if (ownerId && price.amount > 0) {
    // 提交前余额校验（额度校验放在入队前、与入队同一段同步代码里，避免并发穿透）。
    await checkBalance({ ownerId, amount: price.amount, currency: price.currency }, cfg);
  }

  let attempt = 0;
  for (;;) {
    if (opts.isAborted && opts.isAborted()) {
      releaseHold(hold, '任务已停止（排队中）');
      throw new Error('任务已停止（排队中）');
    }
    if (ownerId && Queue.countWaitingByOwner(ownerId) >= s.perUserMaxWaiting) {
      releaseHold(hold, '排队任务过多');
      throw new Error('排队任务过多（已达 ' + s.perUserMaxWaiting + ' 个），请等部分任务完成后再提交');
    }
    attempt += 1;
    // 额度校验 + 入队必须是同一段同步代码：中间不能有 await，否则两个并发提交
    // 都会先读到旧的「已用额度」，一起通过检查后超额。
    if (ownerId && price.amount > 0) {
      try {
        checkQuota({
          ownerId,
          amount: price.amount,
          extraUsed: useWallet ? WalletHolds.activeAmount(ownerId) : Queue.reservedAmount(ownerId),
        }, cfg);
      } catch (e) {
        releaseHold(hold, e.message);
        throw e;
      }
    }
    let item;
    try {
      item = Queue.enqueue({
        jobId,
        projectId,
        ownerId,
        pool,
        kind,
        maxAttempts,
        workerId: G.workerId,
        amount: price.amount,
        unitPrice: price.unitPrice,
        currency: price.currency,
        dedupeKey: opts.dedupeKey || '',
        payload: { ...(opts.payload || {}), chapter: opts.chapter || '', subject: opts.subject || '' },
      });
    } catch (e) {
      releaseHold(hold, '入队失败');
      throw e;
    }
    if (opts.onQueue) opts.onQueue('queued');
    // 让任务面板能看出「现在是在排队还是真在渲染」（不改 job.status：那条状态由业务收尾逻辑管）
    if (jobId) Jobs.update(jobId, { phase: '排队中' });
    try {
      await waitForGrant(item.id, { waitMax, isAborted: opts.isAborted });
    } catch (e) {
      Queue.cancel(item.id, e.message);
      poke();
      releaseHold(hold, e.message);
      throw e;
    }
    if (opts.onQueue) opts.onQueue('running');
    if (jobId) Jobs.update(jobId, { phase: '渲染中' });

    let heartbeat = null;
    try {
      heartbeat = setInterval(() => Queue.touch(item.id, s.leaseMs), Math.max(5000, Math.floor(s.leaseMs / 3)));
      if (heartbeat.unref) heartbeat.unref();
      const r = await fn(item);
      Queue.finish(item.id);
      // 只有真正完成才记账；重试不会重复记账（失败分支不记）
      if (ownerId && price.amount > 0) {
        try {
          if (hold) {
            captureHold(hold.id, { cfg, quantity, unitPrice: price.unitPrice, chapter: opts.chapter || '', subject: opts.subject || '' });
          } else {
            await recordUsage(
              { projectId, ownerId, jobId, kind, quantity, unitPrice: price.unitPrice, currency: price.currency, chapter: opts.chapter || '', subject: opts.subject || '' },
              cfg,
            );
          }
        } catch (e) {
          logger.warn('记录用量失败：' + e.message, { jobId, kind });
        }
      }
      return r;
    } catch (e) {
      const aborted = !!(opts.isAborted && opts.isAborted());
      const providerBusy = !!(e && e.providerStillRunning);
      Queue.fail(item.id, (e && e.message) || String(e), { cancelled: aborted });
      if (!aborted) noteQuotaError(e);
      // 上游任务还在跑（取消失败/取消后仍在 RUNNING）：本地槽位已经释放，
      // 但绝不能再派发下一批，否则会超过账号并发。先暂停派发，等云端进入终态。
      if (providerBusy) {
        pauseQueue(Math.max(10 * 60 * 1000, s.pauseMs), '云端任务尚未释放并发，暂停派发');
      }
      if (!aborted && !providerBusy && attempt < maxAttempts && isRetryableError(e)) {
        // 退避后重新入队：仍然走公平队列，不会因为重试插队
        await sleep(Math.min(10 * 60000, 15000 * 2 ** (attempt - 1)));
        continue;
      }
      // 上游已开始/已完成但被取消（RunningHub 等）：按策略仍然计费，不能因为本地显示“已停止”就退钱。
      if (e && e.billable && ownerId && price.amount > 0) {
        try {
          if (hold) {
            captureHold(hold.id, { cfg, quantity, unitPrice: price.unitPrice, chapter: opts.chapter || '', subject: opts.subject || '上游已开始任务', note: '上游任务已开始/失败，按策略计费' });
          } else {
            await recordUsage(
              { projectId, ownerId, jobId, kind, quantity, unitPrice: price.unitPrice, currency: price.currency, chapter: opts.chapter || '', subject: opts.subject || '上游已开始任务', note: '上游任务已开始/失败，按策略计费' },
              cfg,
            );
          }
          logger.info('上游任务已开始/完成但被停止，按策略计费', { jobId, kind, status: e.providerStatus, code: e.code });
        } catch (billErr) {
          logger.warn('上游已开始任务的计费失败：' + billErr.message, { jobId, kind });
        }
      } else {
        releaseHold(hold, aborted ? '任务已取消' : ((e && e.message) || '渲染失败'));
      }
      throw e;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      poke();
    }
  }
}

// 停止按钮：立即摘除等待条目并唤醒其 placeholder
export function cancelJobQueue(jobId) {
  const rows = Queue.cancelWaitingByJob(jobId);
  for (const r of rows) {
    const w = G.waiters.get(r.id);
    if (w) {
      G.waiters.delete(r.id);
      w.reject(new Error('任务已停止（排队中）'));
    }
  }
  if (rows.length) poke();
  return rows.length;
}

// 公平派发顺序（容量无限时的近似）：按「上次服务时间」排定用户顺序，再逐轮各取一个。
// 用于给用户显示真实名次；O(n)，队列很长时也不会拖慢接口。
export function fairOrder(waiting, lastServed = new Map()) {
  const byOwner = new Map();
  for (const w of waiting) {
    const o = w.ownerId || '';
    if (!byOwner.has(o)) byOwner.set(o, []);
    byOwner.get(o).push(w);
  }
  for (const arr of byOwner.values()) {
    arr.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || (a.seq || 0) - (b.seq || 0));
  }
  const owners = [...byOwner.keys()].sort((a, b) => (lastServed.get(a) || 0) - (lastServed.get(b) || 0));
  const maxLen = [...byOwner.values()].reduce((n, a) => Math.max(n, a.length), 0);
  const order = [];
  for (let r = 0; r < maxLen; r++) {
    for (const o of owners) {
      const it = byOwner.get(o)[r];
      if (it) order.push(it);
    }
  }
  return order;
}

// 队列快照：普通用户只看自己的位置，管理员可看全部条目
export function queueSnapshot({ ownerId = '', isAdmin = false } = {}) {
  const s = queueSettings();
  const running = Queue.running();
  const waiting = Queue.waiting();
  const pools = {};
  for (const [p, conf] of Object.entries(s.pools)) pools[p] = { waiting: 0, running: 0, min: conf.min, max: conf.max, avgMs: 0 };
  const touch = (p) => (pools[p] = pools[p] || { waiting: 0, running: 0, min: 0, max: 0, avgMs: 0 });
  for (const r of running) {
    touch(r.pool).running += 1;
  }
  for (const w of waiting) {
    touch(w.pool).waiting += 1;
  }
  // 平均耗时（近 60 条）用于估算等待时间
  const recent = Queue.recentDurations(60);
  const acc = {};
  for (const r of recent) {
    const d = (r.finished_at || 0) - (r.started_at || 0);
    if (d <= 0) continue;
    acc[r.pool] = acc[r.pool] || { sum: 0, n: 0 };
    acc[r.pool].sum += d;
    acc[r.pool].n += 1;
  }
  for (const [p, v] of Object.entries(acc)) touch(p).avgMs = Math.round(v.sum / v.n);

  let mine = [];
  if (ownerId) {
    // 用「容量无限」下的公平顺序求名次（不是简单按 seq 排——批量提交的人不会把后来者推到队尾）
    const order = fairOrder(waiting, G.lastServed);
    const pos = new Map(order.map((w, i) => [w.id, i + 1]));
    const isMine = (w) => (w.ownerId || '') === ownerId || (ownerId === 'local' && !w.ownerId);
    mine = waiting
      .filter(isMine)
      .map((w) => {
        const position = pos.get(w.id) || null;
        const avg = pools[w.pool]?.avgMs || 0;
        const etaMs = avg && position ? Math.round((avg * position) / Math.max(1, s.capacity)) : 0;
        const pl = w.payload || {};
        return {
          id: w.id, jobId: w.jobId, projectId: w.projectId || '', pool: w.pool, kind: w.kind, status: w.status,
          chapter: pl.chapter || '', subject: pl.subject || '',
          position, etaMs, enqueuedAt: w.enqueuedAt,
        };
      })
      .sort((a, b) => (a.position || 0) - (b.position || 0));
  }

  return {
    enabled: s.enabled,
    capacity: s.capacity,
    running: running.length,
    waiting: waiting.length,
    pausedUntil: G.pausedUntil > Date.now() ? G.pausedUntil : 0,
    pauseReason: G.pausedUntil > Date.now() ? G.pauseReason : '',
    pools,
    mine,
    ...(isAdmin ? { items: [...running, ...waiting] } : {}),
  };
}
