import { loadConfig } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// 渲染槽位闸门
//
// 两级、彼此独立，避免嵌套获取导致死锁：
//
//   1) 任务闸门 runExclusiveVideo —— 同一时刻只允许一个「整条流水线任务」在跑。
//      保留排队/超时/取消语义（前端能看到「排队中」），也避免多个 Agent 会话同时
//      压 LLM（每个任务在文本阶段也要几十次模型调用）。
//
//   2) 渲染项闸门 runRenderSlot —— 每次真正向 ComfyUI / RunningHub 提交渲染占一个槽。
//      这才是并发的来源：一个任务内的多个镜头/资产可以同时提交，上限由
//      concurrencyLimit() 决定。
//
// 为什么分两级：若两级共用一个信号量，任务持槽后子任务再去获取，limit=1 时必然死锁。
// 分开之后任务层永远只有一个持有者，渲染层独立限流，语义清晰。
//
// 状态挂 globalThis：Next.js（含 dev）会为不同 route 各打包一份本模块，
// 模块级变量会让两条 route 各自以为槽位空闲 → 真并发。
// ─────────────────────────────────────────────────────────────────────────────

const JOB_GATE_KEY = '__infiniteCreationVideoGate';
const RENDER_GATE_KEY = '__infiniteCreationRenderGate';

const jobGate = (globalThis[JOB_GATE_KEY] = globalThis[JOB_GATE_KEY] || { slots: 0, queue: [] });
const renderGate = (globalThis[RENDER_GATE_KEY] = globalThis[RENDER_GATE_KEY] || { slots: 0, queue: [] });

// 每个 job 当前占着多少个**渲染**槽位（引用计数）。
// 槽位下沉到渲染项后同一 job 会同时占多个；用 Set 会在第一个子项完成时就把 jobId 删掉，
// 导致 holdsRenderSlot 提前变 false、取消路由不再打断。
renderGate.holderCounts = renderGate.holderCounts instanceof Map ? renderGate.holderCounts : new Map();

/**
 * 「配置声明的」并发上限（保持既有语义：native 用 videoConcurrency，RunningHub 用 runninghubConcurrency）。
 * 注意：真正决定**渲染**并发的是 renderConcurrencyLimit() —— 本地 ComfyUI 被强制为 1。
 */
export function concurrencyLimit(cfg) {
  if (cfg?.comfyui?.provider === 'runninghub') {
    return Math.max(1, Number(cfg.generation?.runninghubConcurrency) || 1);
  }
  return Math.max(1, Number(cfg.generation?.videoConcurrency) || 1);
}

/**
 * 实际生效的**渲染**并发上限。
 * 本地 ComfyUI 恒为 1：它原生单执行队列，并发提交只会让每项多等、更容易撞超时，
 * 且 /interrupt 是全局的，并发时取消会误杀同批其他镜头。
 */
export function renderConcurrencyLimit(cfg) {
  if (cfg?.comfyui?.provider === 'runninghub') {
    return Math.max(1, Number(cfg.generation?.runninghubConcurrency) || 1);
  }
  return 1;
}

/** 当前配置下是否允许并行渲染（决定取消时能不能安全地打全局 /interrupt）。 */
export function concurrencyEnabled(cfg) {
  return renderConcurrencyLimit(cfg) > 1;
}

/** 该任务此刻是否有渲染正在提交/等待（取消路由据此决定要不要打断 ComfyUI）。 */
export function holdsRenderSlot(jobId) {
  return !!(jobId && (renderGate.holderCounts.get(jobId) || 0) > 0);
}

/** 从两条队列里摘掉某任务的全部排队项并中止它们；返回是否摘掉了条目。 */
export function cancelQueuedJob(jobId) {
  let removed = 0;
  for (const g of [jobGate, renderGate]) {
    for (let i = g.queue.length - 1; i >= 0; i--) {
      if (g.queue[i].jobId !== jobId) continue;
      const [e] = g.queue.splice(i, 1);
      e.cancel(new Error('任务已停止（排队中）'));
      removed++;
    }
  }
  return removed > 0;
}

/** 仅供测试/诊断。 */
export function renderGateStats() {
  return {
    jobSlots: jobGate.slots, jobQueued: jobGate.queue.length,
    renderSlots: renderGate.slots, renderQueued: renderGate.queue.length,
    holders: renderGate.holderCounts.size,
  };
}

// 队列超时按「最后一次进度」计时：每当有槽位被释放、有排队项被放行（= 前面的渲染确实在推进），
// 就给仍在排队的项重新计时。否则一个几十张图的批量在本地 ComfyUI（并发 1）下，
// 队尾项会在「前面的任务一直健康地跑着」时被误判为「前置任务疑似卡死」而放弃
//（超时从入队那一刻开始算，不随进度刷新）。
const touchQueued = (gate) => {
  for (const e of gate.queue) { if (e && e.touch) e.touch(); }
};

// —— 通用：在某个闸门上获取一个槽位后执行 fn ——
function withSlot(gate, limit, fn, isAborted, { queueTimeoutMs, jobId, unitId, onQueue, label }) {
  return new Promise((resolve, reject) => {
    const drain = () => {
      while (gate.slots < limit && gate.queue.length) {
        const next = gate.queue.shift();
        next.tryAcquire();
      }
      touchQueued(gate);
    };
    const acquire = () => {
      gate.slots++;
      if (jobId && gate === renderGate) {
        renderGate.holderCounts.set(jobId, (renderGate.holderCounts.get(jobId) || 0) + 1);
      }
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          gate.slots--;
          if (jobId && gate === renderGate) {
            const n = (renderGate.holderCounts.get(jobId) || 0) - 1;
            if (n > 0) renderGate.holderCounts.set(jobId, n); else renderGate.holderCounts.delete(jobId);
          }
          drain();
        });
    };
    if (gate.slots < limit) { acquire(); return; }

    if (isAborted && isAborted()) {
      reject(new Error('任务在排队等待' + label + '时已被停止'));
      return;
    }
    if (onQueue) onQueue('queued');
    const waitMax = queueTimeoutMs || (Number(loadConfig().generation?.videoQueueTimeoutMinutes) || 120) * 60 * 1000;
    let timer;
    const onTimeout = () => {
      const i = gate.queue.indexOf(entry);
      if (i >= 0) gate.queue.splice(i, 1);
      reject(new Error('等待' + label + '超时（' + Math.round(waitMax / 60000) + ' 分钟）。前置任务疑似卡死，本项已主动放弃。'));
    };
    const entry = {
      jobId,
      unitId,
      tryAcquire: () => {
        clearTimeout(timer);
        if (isAborted && isAborted()) return reject(new Error('任务在排队等待' + label + '时已被停止'));
        if (onQueue) onQueue('running');
        acquire();
      },
      cancel: (err) => { clearTimeout(timer); reject(err); },
      // 队列有进展时重置等待计时（见 touchQueued）：超时语义 = 「waitMax 内没有任何进度」
      touch: () => {
        clearTimeout(timer);
        timer = setTimeout(onTimeout, waitMax);
      },
    };
    timer = setTimeout(onTimeout, waitMax);
    gate.queue.push(entry);
  });
}

/**
 * 任务闸门：整条流水线任务串行执行。
 * @param {() => Promise<any>} fn
 * @param {() => boolean} [isAborted]
 * @param {{ queueTimeoutMs?: number, jobId?: string, onQueue?: (s: 'queued'|'running') => void }} [opts]
 */
export function runExclusiveVideo(fn, isAborted, opts = {}) {
  // 任务层恒为 1：并发的收益交给渲染项闸门，这里只负责「同一时刻一个流水线」。
  return withSlot(jobGate, 1, fn, isAborted, { ...opts, label: '视频槽位' });
}

/**
 * 渲染项闸门：每次向 ComfyUI / RunningHub 提交占一个槽。
 * @param {() => Promise<any>} fn
 * @param {{ jobId?: string, unitId?: string, isAborted?: () => boolean, queueTimeoutMs?: number, onQueue?: (s: 'queued'|'running') => void }} [opts]
 */
export function runRenderSlot(fn, { jobId, unitId, isAborted, queueTimeoutMs, onQueue } = {}) {
  const limit = renderConcurrencyLimit(loadConfig());
  return withSlot(renderGate, limit, fn, isAborted, { jobId, unitId, queueTimeoutMs, onQueue, label: '渲染槽位' });
}
