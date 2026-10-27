#!/usr/bin/env node
// 会话令牌签发工具：给宿主项目生成可传给 iframe 的 session token。
//
// 用法：
//   node scripts/make-session-token.mjs <sessionId> [有效小时数]
//   pnpm run session:token -- user-123 24
//
// 设置了 IC_SESSION_SECRET 时签发带 HMAC 签名的令牌（服务端会校验）；
// 未设置时只输出会话 id（服务端只做「存在性」校验，适合内网/受信网关）。
import { mintSessionToken, sessionSecret } from '../lib/core/session.js';

const [id, ttlArg] = process.argv.slice(2);
if (!id) {
  console.error('用法: node scripts/make-session-token.mjs <sessionId> [有效小时数]');
  process.exit(1);
}

const ttlHours = Number(ttlArg) || 24;
const token = mintSessionToken(id, { ttlSeconds: Math.max(60, Math.round(ttlHours * 3600)) });

// 仅供管道读取：token 永远只写 stdout
console.log(token);
if (!sessionSecret()) {
  console.error('[提示] 未设置 IC_SESSION_SECRET：当前令牌只做存在性校验，不防伪造。外网部署请设置密钥后重新签发。');
}
