// 请求级身份上下文：server.js 在认证通过后用 runWithActor 包裹整个请求，
// db 层据此做项目归属过滤；后台任务没有 actor 时不做限制（它们只操作自己项目的 id）。
import { AsyncLocalStorage } from 'node:async_hooks';

const g = globalThis;
// server.js（原生 ESM）与 Next 打包后的 route 可能各持有一份本模块；
// 必须共用同一个 AsyncLocalStorage 实例，否则 db 层读不到请求用户。
const storage = g.__icActorStorage || (g.__icActorStorage = new AsyncLocalStorage());

export function runWithActor(actor, fn) {
  return storage.run(actor || {}, fn);
}

export function currentActor() {
  return storage.getStore() || null;
}

export function currentUser() {
  const actor = currentActor();
  return actor && actor.user ? actor.user : null;
}

export function isAdminActor() {
  const user = currentUser();
  return !!user && user.role === 'admin';
}
