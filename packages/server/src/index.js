import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { DATA_DIR, ROOT, ensureDirs, loadConfig, Workflows, DEFAULT_SPECS, logger } from '@ic/core';
import { scanSkills } from '@ic/agent';
import { createRouter } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

ensureDirs();
// 启动时注册默认工作流 + 扫描技能
for (const spec of DEFAULT_SPECS) {
  Workflows.upsert({ name: spec.name, kind: spec.kind, sourceFile: spec.sourceFile, spec, status: 'active' });
}
const skills = scanSkills();
logger.info('启动：注册工作流 ' + DEFAULT_SPECS.length + ' 个，技能 ' + skills.length + ' 个');

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' }));

// 静态文件：/files/<相对 DATA_DIR 的路径>
app.use('/files', express.static(DATA_DIR, { fallthrough: false, maxAge: '1h' }));
app.use('/files', (err, req, res, next) => { if (err) return res.status(404).end(); next(); });

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(msg);
  }
}

app.use('/api', createRouter({ broadcast }));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// 生产：托管前端构建产物
const webDist = path.join(ROOT, 'packages', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/files') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  logger.error('HTTP 错误', { error: err.message });
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

const cfg = loadConfig();
const port = process.env.PORT || cfg.server.port;
server.listen(port, () => {
  console.log('infinite-creation 后端已启动: http://127.0.0.1:' + port);
  console.log('  ComfyUI: ' + cfg.comfyui.baseUrl);
  console.log('  LLM:     ' + cfg.llm.baseUrl + ' (' + cfg.llm.model + ')');
});
