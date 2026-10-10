// WebSocket 广播的桥接：server.js 启动时注入真实广播函数，
// API route handlers 通过 broadcast() 推送任务进度，避免循环依赖 server.js。
// 必须挂在 globalThis：Next.js（尤其 dev 模式）会为 server.js 与各 route 分别打包一份本模块，
// 模块级变量会导致 server.js setBroadcaster 设置的函数，route 里的 broadcast() 永远读不到
// （= 前端 WS 收不到任何进度/完成通知，只能靠轮询）。globalThis 跨模块实例共享。
// 同 job-runner.js 里 abortFlags 的处理。
const KEY = '__infiniteCreationBroadcast';

export function setBroadcaster(fn) {
  globalThis[KEY] = typeof fn === 'function' ? fn : () => {};
}

export function broadcast(obj) {
  const fn = globalThis[KEY];
  if (fn) fn(obj);
}
