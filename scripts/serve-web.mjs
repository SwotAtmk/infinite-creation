// Web 入口：一个进程按 WEB_MODE 提供 Studio 或经典界面，不依赖 nginx / vite preview。
//   WEB_MODE=studio  -> 托管 studio/dist（SPA fallback），/api、/files、/ws 转发后端
//   WEB_MODE=classic -> 所有请求原样转发后端（后端自带经典 Next 页面）
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'studio', 'dist');
const PORT = Number(process.env.PORT || process.env.STUDIO_PORT || 4710);
const BACKEND = new URL(process.env.STUDIO_BACKEND || 'http://app:4610');
const BACKEND_HOST = BACKEND.hostname;
const BACKEND_PORT = Number(BACKEND.port || 80);
const WEB_MODE = String(process.env.WEB_MODE || 'studio').toLowerCase() === 'classic' ? 'classic' : 'studio';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: BACKEND.host };
  const upstream = http.request(
    { hostname: BACKEND_HOST, port: BACKEND_PORT, path: req.url, method: req.method, headers },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    if (!res.headersSent) send(res, 502, 'Bad gateway: ' + e.message, { 'Content-Type': 'text/plain; charset=utf-8' });
    else res.destroy();
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  } catch {
    send(res, 400, 'Bad request');
    return;
  }
  let rel = pathname.replace(/^\/+/, '');
  let abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    send(res, 403, 'Forbidden');
    return;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    abs = path.join(ROOT, 'index.html');
  }
  let body;
  try {
    body = fs.readFileSync(abs);
  } catch {
    send(res, 404, 'Not found');
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
  send(res, 200, body, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': cache,
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (WEB_MODE === 'classic') {
    proxyHttp(req, res);
    return;
  }
  if (url.startsWith('/api') || url.startsWith('/files')) {
    proxyHttp(req, res);
    return;
  }
  serveStatic(req, res);
});

// WebSocket：把原始 TCP 连接转发给后端，保留 Upgrade 握手头。
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    const lines = [
      `${req.method} ${req.url} HTTP/${req.httpVersion}`,
      ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`),
      '',
      '',
    ];
    upstream.write(lines.join('\r\n'));
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => {
    try { socket.destroy(); } catch { /* ignore */ }
  });
  socket.on('error', () => {
    try { upstream.destroy(); } catch { /* ignore */ }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Web 入口已启动: http://0.0.0.0:' + PORT + ' mode=' + WEB_MODE + ' -> ' + BACKEND.origin);
});
