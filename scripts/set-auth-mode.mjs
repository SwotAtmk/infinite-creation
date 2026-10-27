#!/usr/bin/env node
// 服务器本机应急切换登录模式（不经 HTTP，反向代理部署也不会误判来源）。
//
//   node scripts/set-auth-mode.mjs false   # 免登录
//   node scripts/set-auth-mode.mjs true    # 需要登录
//   node scripts/set-auth-mode.mjs auto    # 跟随 IC_AUTH 环境变量
//
// 正常切换请用管理后台（需要管理员登录），这个脚本只用于后台进不去/忘了密码时救急。
import { loadConfig, saveConfig } from '../lib/core/config.js';

const arg = String(process.argv[2] ?? '').trim().toLowerCase();
const modes = {
  true: true, '1': true, on: true, yes: true,
  false: false, '0': false, off: false, no: false,
  auto: null, null: null, default: null,
};

if (!(arg in modes)) {
  console.error('用法: node scripts/set-auth-mode.mjs <true|false|auto>');
  console.error('  false = 免登录，true = 需要登录，auto = 跟随 IC_AUTH');
  process.exit(1);
}

const enabled = modes[arg];
const cfg = loadConfig();
saveConfig({ ...cfg, auth: { ...(cfg.auth || {}), enabled } });
console.log(
  enabled === null
    ? 'auth.enabled = null（跟随 IC_AUTH）'
    : 'auth.enabled = ' + enabled + (enabled ? '（需要登录）' : '（免登录）'),
);
console.log('运行中的服务最多 2 秒后生效（模式缓存）。');
