// WebSocket 广播的桥接：server.js 启动时注入真实广播函数，
// API route handlers 通过 broadcast() 推送任务进度，避免循环依赖 server.js。
let _broadcast = () => {};

export function setBroadcaster(fn) {
  _broadcast = typeof fn === 'function' ? fn : () => {};
}

export function broadcast(obj) {
  _broadcast(obj);
}
