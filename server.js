// 必须最先执行：后台启动时注入 git-bash 路径，避免 openclaude SDK 直接退出进程
import './lib/core/ensure-git-bash.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { PROJECTS_DIR, ensureDirs, loadConfig, Workflows, DEFAULT_SPECS, logger, startupCleanup, maskComfyBaseUrl } from './lib/core/index.js';
import { scanSkills } from './lib/agent/index.js';
import { setBroadcaster } from './lib/ws.js';
import { startScheduler } from './lib/core/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, dir: __dirname });
const handle = app.getRequestHandler();

// 开源版没有账号体系：项目归属、展示库与角色权限相关逻辑已移除。


// 启动时注册默认工作流 + 扫描技能
ensureDirs();
startupCleanup();
// RunningHub 渲染公平队列：进程内调度器（本地 ComfyUI 模式不启用，见 scheduler.queueEnabled）
startScheduler();
// 清理已被改名/删除的陈旧工作流记录：upsert 按 name 匹配，改名后会留下孤儿行（下拉出现重复选项），
// 先按当前 DEFAULT_SPECS 的名称集合剔除不在其中的记录，再注册，保证列表与规格一致。
const validWorkflowNames = new Set(DEFAULT_SPECS.map((s) => s.name));
for (const w of Workflows.list()) {
  if (!validWorkflowNames.has(w.name)) Workflows.remove(w.id);
}
for (const spec of DEFAULT_SPECS) {
  Workflows.upsert({ name: spec.name, kind: spec.kind, sourceFile: spec.sourceFile, spec, status: 'active' });
}
const skills = scanSkills();
logger.info('启动：注册工作流 ' + DEFAULT_SPECS.length + ' 个，技能 ' + skills.length + ' 个');

// —— /files 静态托管：把 data/ 目录下的资产/分镜/成片映射为 /files/<相对路径> ——
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.m4v': 'video/mp4', '.avi': 'video/x-msvideo',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/plain', '.zip': 'application/zip',
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

function serveFile(res, req, abs) {
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
    const ext = path.extname(abs).toLowerCase();
    const total = fs.statSync(abs).size;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      // index.html 不缓存：否则重新构建前端后仍引用已删除的旧 hash 资源
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    };
    const range = req.headers.range;
    if (range) {
      // Range 支持：浏览器 <video>/<audio> 拖进度条靠它（206 分段返回），缺失则无法 seek
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      const reject = () => { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); };
      if (!m || (!m[1] && !m[2])) { reject(); return true; }
      let start;
      let end;
      if (!m[1]) {
        // 后缀范围 `bytes=-N` = **最后** N 字节。原实现无论有没有起始值都按 start=0 算，
        // 于是 `bytes=-1000` 返回的是**开头** 1000 字节（还回 206 + Content-Range，看不出异常）：
        // 拖到片尾反而拿到片头。`bytes=-0` 非法，按 RFC 回 416。
        const n = Number(m[2]);
        if (!Number.isFinite(n) || n <= 0) { reject(); return true; }
        start = Math.max(total - n, 0);
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || start > end) { reject(); return true; }
      }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(abs, { start, end }).pipe(res);
    } else {
      // 无 Range：整文件返回（流式，避免大文件全量进内存）
      res.writeHead(200, { ...headers, 'Content-Length': total });
      fs.createReadStream(abs).pipe(res);
    }
    return true;
  } catch {
    return false;
  }
}

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    // 客户端自带的 x-ic-* 身份头一律丢弃：这些头只能由下面的认证结果写入。
    // 否则匿名请求只要带上 X-IC-User-Role: admin 就能冒充管理员
    //（实测能通过 /api/queue 拿到管理员才可见的 items，也能影响项目列表的归属过滤）。
    delete req.headers['x-ic-user-id'];
    delete req.headers['x-ic-user-role'];
    delete req.headers['x-ic-guest'];
    // req.url 是客户端给的原文，这一层又跑在 Next 之外（抛出的异常没有任何兜底）：
    // `GET //` 会让 new URL 抛 TypeError、`/files/%E0%A4%A` 会让 decodeURIComponent 抛 URIError，
    // 两者都会直接杀死整个进程——正在跑的任务一起没了、jobs 留在 running。
    // 一律按 400 处理：畸形请求不该拖垮服务（不能靠全局 uncaughtException 兜，那种「继续跑」的状态不可信）。
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const proceed = () => {
      if (url.pathname.startsWith('/files/')) {
      // 相对路径 -> data/ 下的绝对路径，并做路径穿越防护。
      // 只放开 data/projects/：data/ 根下还放着数据库（ic.db）等本不该对外暴露的文件，
      // 前台所有 /files 链接都是 /files/projects/<项目id>/... ，收窄到项目目录不影响功能。
      // 相对路径 -> 媒体目录下的绝对路径，并做路径穿越防护。
      // 前台所有 /files 链接都是 /files/projects/<项目id>/...；媒体根目录可由 IC_MEDIA_DIR
      // 独立挂载（Docker volume），所以不能再按 DATA_DIR/projects 拼。
      let rel;
      try {
        rel = decodeURIComponent(url.pathname.slice('/files/'.length));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const cleanRel = rel.replace(/^\/+/, '');
      if (!cleanRel.startsWith('projects/')) {
        res.writeHead(404).end();
        return;
      }
      const abs = path.resolve(PROJECTS_DIR, cleanRel.slice('projects/'.length));
      const safe = path.relative(PROJECTS_DIR, abs);
      if (safe && !safe.startsWith('..') && !path.isAbsolute(safe) && serveFile(res, req, abs)) return;
      res.writeHead(404).end();
      return;
    }
    handle(req, res);
    };

    proceed();
  });

  const wss = new WebSocketServer({ noServer: true });
  setBroadcaster((obj) => {
    const msg = JSON.stringify(obj);
    for (const c of wss.clients) {
      if (c.readyState !== 1) continue;
      c.send(msg);
    }
  });

  // WebSocket 升级路由：/ws 交给业务广播，/_next/* 交给 Next.js 的 HMR 热更新。
  // 之前 wss 用 path:'/ws' 会把 /_next/webpack-hmr 的升级请求以 400 拒绝并销毁连接，
  // 导致浏览器报 “WebSocket connection to .../_next/webpack-hmr failed”。
  const upgradeHandler = app.getUpgradeHandler();
  server.on('upgrade', (req, socket, head) => {
    // 客户端在升级握手中途断开（ECONNRESET）会让 raw socket 触发 'error'：没有监听器时
    // EventEmitter 直接抛出，同样杀进程。这里先兜住，业务错误由下面的 ws 监听器负责。
    socket.on('error', () => {});
    // 同上：畸形 URL（如 `//`）会在 new URL 抛异常，而这里是 upgrade 事件回调，
    // 抛出去同样无人接管、直接杀进程。升级请求容错更简单：直接断开。
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        // ws 的 'error' 必须有监听器：客户端发一个畸形帧（未掩码 / 非法 opcode / 非法 UTF-8 /
        // 超 maxPayload）就会触发它，而这里是「无订阅者的 emit」——全仓没有 wss.on('connection')，
        // ws 对象上没有任何业务监听器，'error' 抛出即 uncaughtException。
        // 实测（生产模式 `npm start`，无 Next 的全局兜底）：一个未掩码帧就能让整个进程退出，
        // 正在跑的任务全丢、jobs 永远停在 running。dev 下只是被 Next 的兜底接住、日志里留一行。
        ws.on('error', (e) => logger.warn('WebSocket 客户端异常，已断开该连接：' + ((e && e.message) || e)));
        wss.emit('connection', ws, req);
      });
    } else if (url.pathname.startsWith('/_next/')) {
      upgradeHandler(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  const cfg = loadConfig();
  const port = process.env.PORT || cfg.server?.port || 4600;
  // 默认只绑环回地址：本服务没有任何鉴权（改配置 / 删项目 / 读日志全开放）。
  // 优先级：环境变量 HOST > config.json 的 server.host > 默认 127.0.0.1
  // Docker / 反向代理部署用 HOST=0.0.0.0；局域网自用也可以写进 config.json。
  let host = process.env.HOST || '';
  if (!host && typeof cfg?.server?.host === 'string' && cfg.server.host.trim()) {
    host = cfg.server.host.trim();
  }
  if (!host) host = '127.0.0.1';
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    console.log('infinite-creation 已启动: http://' + shown + ':' + port + (dev ? '（开发模式）' : ''));
    console.log('  ComfyUI: ' + maskComfyBaseUrl(cfg));
    console.log('  LLM:     ' + cfg.llm.baseUrl + ' (' + cfg.llm.model + ')');
    if (process.env.IC_PUBLIC === '1') {
      console.log('  公开模式：/api/config 不返回密钥且禁止修改（RunningHub Key 仅服务端可见）');
    }
  });
});
