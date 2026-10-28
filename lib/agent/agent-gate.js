// 进程级 Agent 会话闸门：限制同一个后端进程里同时运行的章节 Agent 数量。
//
// 为什么需要：解除 openclaude SDK 的 env 锁后，多个章节可以真正并行；但如果一次
// 启动十几章，会同时向上游 LLM 发大量请求，容易触发限流/额度问题。这里按「章节」
// 发槽位，超出的任务停在「等待 Agent 槽位」，等前面的章节结束后再开始。
//
// 状态挂 globalThis：Next.js 会为不同 route 各打包一份本模块，模块级变量会让
// 两个入口各算各的；globalThis 才能让 job-runner / stages / 工具调用共享同一个闸门。
const G = (globalThis.__icAgentGate = globalThis.__icAgentGate || {
  active: 0,
  limit: 0,
  queue: [],
});

export function agentConcurrency(cfg) {
  const n = Number(cfg?.generation?.agentConcurrency);
  return Math.max(1, Math.min(32, Number.isFinite(n) && n > 0 ? Math.round(n) : 4));
}

export function agentQueueTimeoutMs(cfg) {
  const m = Number(cfg?.generation?.agentQueueTimeoutMinutes);
  return Math.max(1, Number.isFinite(m) && m > 0 ? Math.round(m) : 120) * 60000;
}

function makeRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    G.active = Math.max(0, G.active - 1);
    drain();
  };
}

function remove(entry) {
  const i = G.queue.indexOf(entry);
  if (i >= 0) G.queue.splice(i, 1);
}

function drain() {
  while (G.active < G.limit && G.queue.length) {
    const entry = G.queue.shift();
    if (entry.settled) continue;
    entry.settled = true;
    clearTimeout(entry.timer);
    clearInterval(entry.watch);
    G.active += 1;
    entry.resolve(makeRelease());
  }
}

/**
 * 拿一个 Agent 槽位。返回的 release 必须调用（建议 try/finally）。
 * 排队期间每 2 秒检查一次 isAborted，停止按钮不需要等轮到才生效。
 */
export function acquireAgentSlot({ limit, waitMaxMs = 120 * 60000, isAborted, onWait } = {}) {
  const lim = Math.max(1, Math.min(32, Number(limit) || 1));
  G.limit = lim;

  if (isAborted && isAborted()) {
    return Promise.reject(Object.assign(new Error('任务已停止（等待 Agent 槽位）'), { code: 'AGENT_QUEUE_ABORTED' }));
  }
  // 即使当前有空位，只要前面有人排队也按 FIFO 走，避免后来的任务插队。
  if (G.active < lim && !G.queue.length) {
    G.active += 1;
    return Promise.resolve(makeRelease());
  }

  if (onWait) {
    try {
      onWait({ active: G.active, waiting: G.queue.length + 1, limit: lim });
    } catch {
      /* 进度上报失败不影响排队 */
    }
  }

  return new Promise((resolve, reject) => {
    const entry = { settled: false, resolve, reject, timer: null, watch: null };
    const fail = (err) => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      clearInterval(entry.watch);
      remove(entry);
      reject(err);
    };
    entry.timer = setTimeout(
      () => fail(Object.assign(new Error('等待 Agent 槽位超时（' + Math.round(waitMaxMs / 60000) + ' 分钟），已放弃'), { code: 'AGENT_QUEUE_TIMEOUT' })),
      Math.max(1000, Number(waitMaxMs) || 120 * 60000),
    );
    if (entry.timer.unref) entry.timer.unref();
    entry.watch = setInterval(() => {
      if (isAborted && isAborted()) {
        fail(Object.assign(new Error('任务已停止（等待 Agent 槽位）'), { code: 'AGENT_QUEUE_ABORTED' }));
      }
    }, 2000);
    if (entry.watch.unref) entry.watch.unref();
    G.queue.push(entry);
    // limit 可能刚被调大；立刻尝试派发。
    drain();
  });
}

export function agentGateSnapshot() {
  return { active: G.active, waiting: G.queue.length, limit: G.limit };
}

// 仅测试用：清空队列并把计数归零。
export function resetAgentGateForTest() {
  for (const entry of G.queue.splice(0)) {
    if (entry.settled) continue;
    entry.settled = true;
    clearTimeout(entry.timer);
    clearInterval(entry.watch);
    entry.reject(Object.assign(new Error('test reset'), { code: 'AGENT_QUEUE_RESET' }));
  }
  G.active = 0;
  G.limit = 0;
}
