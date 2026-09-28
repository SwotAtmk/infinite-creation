import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { DATA_DIR, ensureDirs, loadConfig, Workflows, DEFAULT_SPECS, logger } from './lib/core/index.js';
import { scanSkills } from './lib/agent/index.js';
import { setBroadcaster } from './lib/ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, dir: __dirname });
const handle = app.getRequestHandler();

// 启动时注册默认工作流 + 扫描技能
ensureDirs();
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

function serveFile(res, abs) {
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
    const ext = path.extname(abs).toLowerCase();
    const buf = fs.readFileSync(abs);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(buf);
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
      if (safe && !safe.startsWith('..') && !path.isAbsolute(safe) && serveFile(res, abs)) return;
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
