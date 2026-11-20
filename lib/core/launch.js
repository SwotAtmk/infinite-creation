import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// 启动记录：data/launch.json，记录首次启动时间与累计启动次数。
// 前端据此判断「是否不是首次启动」，用于在第二次及之后的启动时弹出问卷提示。
const LAUNCH_FILE = path.join(DATA_DIR, 'launch.json');

export function readLaunchState() {
  try {
    const raw = JSON.parse(fs.readFileSync(LAUNCH_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.firstLaunchAt) return null;
    return {
      firstLaunchAt: String(raw.firstLaunchAt),
      lastLaunchAt: String(raw.lastLaunchAt || raw.firstLaunchAt),
      launchCount: Number(raw.launchCount) || 1,
    };
  } catch {
    return null;
  }
}

// 服务启动时调用：首次启动写入时间节点，之后每次启动累加次数。
export function recordLaunch() {
  const prev = readLaunchState();
  const now = new Date().toISOString();
  const next = {
    firstLaunchAt: prev ? prev.firstLaunchAt : now,
    lastLaunchAt: now,
    launchCount: (prev ? prev.launchCount : 0) + 1,
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LAUNCH_FILE, JSON.stringify(next, null, 2));
  } catch {
    // 只读挂载等场景无法写入：不影响服务启动
  }
  return next;
}
