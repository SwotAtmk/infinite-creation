import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { DATA_DIR, ensureDirs, loadConfig, Workflows, DEFAULT_SPECS, logger, startupCleanup } from './lib/core/index.js';
import { scanSkills } from './lib/agent/index.js';
import { setBroadcaster } from './lib/ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, dir: __dirname });
const handle = app.getRequestHandler();

// 启动时注册默认工作流 + 扫描技能
ensureDirs();
startupCleanup();
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
};

function serveFile(res, req, abs) {
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
    const ext = path.extname(abs).toLowerCase();
    const total = fs.statSync(abs).size;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    };
    const range = req.headers.range;
    if (range) {
      // Range 支持：浏览器 <video>/<audio> 拖进度条靠它（206 分段返回），缺失则无法 seek
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || !m[1] && !m[2]) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return true; }
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (start >= total || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return true; }
      end = Math.min(end, total - 1);
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
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/files/')) {
      // 相对路径 -> data/ 下的绝对路径，并做路径穿越防护
      const rel = decodeURIComponent(url.pathname.slice('/files/'.length));
      const abs = path.resolve(DATA_DIR, '.' + path.sep + rel.replace(/^\/+/, ''));
      const safe = path.relative(DATA_DIR, abs);
      if (safe && !safe.startsWith('..') && !path.isAbsolute(safe) && serveFile(res, req, abs)) return;
      res.writeHead(404).end();
      return;
    }
    handle(req, res);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  setBroadcaster((obj) => {
    const msg = JSON.stringify(obj);
    for (const c of wss.clients) {
      if (c.readyState === 1) c.send(msg);
    }
  });

  const cfg = loadConfig();
  const port = process.env.PORT || cfg.server.port || 4600;
  server.listen(port, () => {
    console.log('infinite-creation 已启动: http://127.0.0.1:' + port + (dev ? '（开发模式）' : ''));
    console.log('  ComfyUI: ' + cfg.comfyui.baseUrl);
    console.log('  LLM:     ' + cfg.llm.baseUrl + ' (' + cfg.llm.model + ')');
  });
});
