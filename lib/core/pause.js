// 任务暂停标记：积分不足时不只是“这一步失败”，而是让整个任务停止继续请求。
// 挂在 globalThis，避免 Next 为不同 route 打包出多份模块后互不相认。
const G = (globalThis.__icPausedJobs = globalThis.__icPausedJobs || new Map());

export function markJobPaused(jobId, reason) {
  if (!jobId) return;
  G.set(String(jobId), String(reason || '积分不足'));
}

export function isJobPaused(jobId) {
  return !!jobId && G.has(String(jobId));
}

export function pausedReason(jobId) {
  return (jobId && G.get(String(jobId))) || '';
}

export function clearJobPaused(jobId) {
  if (jobId) G.delete(String(jobId));
}
