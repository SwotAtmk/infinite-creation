import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import AdmZip from 'adm-zip';
import {
  Projects, Assets, Shots, Chapters, Jobs, Workflows, Skills,
  loadConfig, saveConfig, checkComfyUI, ensureProjectDirs, projectDir, resolveProjectPath,
  mergeVideos, DEFAULT_SPECS, logger, uid, slugify,
} from '@ic/core';
import { PROJECT_ASSET_SUBDIRS } from '@ic/shared';
import {
  scanSkills, installSkillsFromZip, startCreateJob, startRegenerateJob, startAssetImageJob, startAssetVoiceJob, startCostumeJob,
  activeJobOf, stopJob, createToolRuntime, runTool,
} from '@ic/agent';

export function createRouter({ broadcast }) {
  const router = express.Router();

  // ===== 配置 / 健康 =====
  router.get('/health', (req, res) => res.json({ ok: true }));
  router.get('/config', (req, res) => res.json(loadConfig()));
  router.put('/config', (req, res) => { res.json(saveConfig(req.body || {})); });
  router.post('/comfyui/test', async (req, res) => {
    // 优先测试前端输入框当前值，未传则回退到已保存配置
    const baseUrl = (req.body && req.body.baseUrl) || loadConfig().comfyui.baseUrl;
    res.json(await checkComfyUI(baseUrl));
  });

  // ===== 项目 =====
  router.get('/projects', (req, res) => {
    const list = Projects.list().map((p) => ({
      id: p.id, name: p.name, style: p.style, status: p.status,
      assetCount: Assets.list(p.id).length, shotCount: Shots.list(p.id).length,
      updatedAt: p.updated_at,
    }));
    res.json(list);
  });
  router.post('/projects', (req, res) => {
    const p = Projects.create(req.body || {});
    ensureProjectDirs(p.id);
    res.json(p);
  });
  router.get('/projects/:id', (req, res) => {
    const p = Projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: '项目不存在' });
    res.json(p);
  });
  router.patch('/projects/:id', (req, res) => {
    const p = Projects.update(req.params.id, req.body || {});
    if (!p) return res.status(404).json({ error: '项目不存在' });
    res.json(p);
  });
  router.delete('/projects/:id', (req, res) => {
    Projects.remove(req.params.id);
    try { fs.rmSync(projectDir(req.params.id), { recursive: true, force: true }); } catch {}
    res.json({ ok: true });
  });
  router.post('/projects/:id/run', (req, res) => {
    const p = Projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: '项目不存在' });
    if (activeJobOf(p.id)) return res.status(409).json({ error: '已有运行中的任务' });
    Projects.update(p.id, { status: 'running' });
    const job = startCreateJob({ projectId: p.id, chapter: req.body?.chapter, onProgress: (patch) => broadcast(patch) });
    res.json(job);
  });
  router.post('/projects/:id/stop', (req, res) => {
    const jobs = Jobs.list(req.params.id).filter((j) => j.status === 'running');
    for (const j of jobs) stopJob(j.id);
    Projects.update(req.params.id, { status: 'idle' });
    res.json({ stopped: jobs.length });
  });
  router.get('/projects/:id/jobs', (req, res) => res.json(Jobs.list(req.params.id)));
  // 查看某次任务的详细日志（Agent 的工具调用/技能加载/进度/输出）
  router.get('/projects/:id/jobs/:jobId/log', (req, res) => {
    const job = Jobs.get(req.params.jobId);
    const logPath = job?.logPath || path.join(projectDir(req.params.id), 'logs', req.params.jobId + '.log');
    try {
      res.json({ jobId: req.params.jobId, logPath, text: fs.readFileSync(logPath, 'utf8') });
    } catch {
      res.json({ jobId: req.params.jobId, logPath, text: '' });
    }
  });
  router.get('/projects/:id/context', (req, res) => {
    const p = Projects.get(req.params.id);
    res.json(p?.context || {});
  });

  // ===== Agent 工具接口（供 DSH 插件工具经 HTTP 调用本工程逻辑）=====
  router.post('/projects/:id/agent-tool', async (req, res) => {
    try {
      const { tool, args = {}, chapter } = req.body || {};
      if (!tool) return res.status(400).json({ error: '缺少 tool' });
      const jobId = 'http-' + Date.now();
      const ctx = createToolRuntime({
        projectId: req.params.id,
        jobId,
        onProgress: (p) => broadcast({ projectId: req.params.id, jobId, ...p }),
        isAborted: () => false,
        chapter: chapter || '',
      });
      const result = await runTool(ctx, tool, args);
      res.json({ result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ===== 章节 =====
  router.get('/projects/:id/chapters', (req, res) => {
    const chs = Chapters.list(req.params.id);
    const all = Shots.list(req.params.id);
    res.json(chs.map((c) => {
      const shots = all.filter((s) => s.chapter === c.title);
      const done = shots.filter((s) => s.status === 'done').length;
      let gen = 'empty';
      if (shots.length) { if (done === shots.length) gen = 'done'; else if (shots.some((s) => s.status === 'running')) gen = 'running'; else if (shots.some((s) => s.status === 'failed')) gen = 'failed'; else gen = 'pending'; }
      return { ...c, shotCount: shots.length, doneCount: done, genStatus: gen };
    }));
  });
  router.post('/projects/:id/chapters', (req, res) => {
    const c = Chapters.create(req.params.id, req.body || {});
    res.json(c);
  });
  router.patch('/projects/:id/chapters/:cid', (req, res) => {
    const before = Chapters.get(req.params.cid);
    const c = Chapters.update(req.params.cid, req.body || {});
    if (!c) return res.status(404).json({ error: '章节不存在' });
    if (before && req.body?.title && before.title !== c.title) {
      for (const s of Shots.list(req.params.id)) if (s.chapter === before.title) Shots.update(s.id, { chapter: c.title });
    }
    res.json(c);
  });
  router.delete('/projects/:id/chapters/:cid', (req, res) => {
    Chapters.remove(req.params.cid);
    res.json({ ok: true });
  });
  router.post('/projects/:id/chapters/:cid/regenerate', (req, res) => {
    const ch = Chapters.get(req.params.cid);
    if (!ch || ch.project_id !== req.params.id) return res.status(404).json({ error: '章节不存在' });
    const mode = req.query?.mode === 'full' ? 'full' : 'videos';
    const shots = Shots.list(req.params.id).filter((s) => s.chapter === ch.title);
    let n = 0;
    for (const s of shots) {
      if (mode === 'full') { Shots.remove(s.id); } else { Shots.update(s.id, { status: 'pending', video_path: '', seed: 0, error: '' }); }
      n++;
    }
    Chapters.update(ch.id, { status: 'pending' });
    res.json({ reset: n, chapter: ch.title, mode });
  });

  // ===== 资产 =====
  router.get('/projects/:id/assets', (req, res) => res.json(Assets.list(req.params.id, req.query.category || null)));
  router.post('/projects/:id/assets', (req, res) => {
    const { category = 'other', name, description = '' } = req.body || {};
    if (!name) return res.status(400).json({ error: '缺少 name' });
    res.json(Assets.create(req.params.id, { category, name, description }));
  });
  router.patch('/projects/:id/assets/:aid', (req, res) => res.json(Assets.update(req.params.aid, req.body || {})));
  router.delete('/projects/:id/assets/:aid', (req, res) => { Assets.remove(req.params.aid); res.json({ ok: true }); });
  router.post('/projects/:id/assets/:aid/generate', (req, res) => {
    const a = Assets.get(req.params.aid);
    if (!a || a.project_id !== req.params.id) return res.status(404).json({ error: '资产不存在' });
    const job = startAssetImageJob({ projectId: req.params.id, assetId: req.params.aid, mode: req.body?.mode === 'i2i' ? 'i2i' : 't2i', prompt: req.body?.prompt, onProgress: (p) => broadcast(p) });
    res.json(job);
  });
  router.post('/projects/:id/assets/:aid/design-voice', (req, res) => {
    const a = Assets.get(req.params.aid);
    if (!a || a.project_id !== req.params.id) return res.status(404).json({ error: '资产不存在' });
    const job = startAssetVoiceJob({ projectId: req.params.id, assetId: req.params.aid, text: req.body?.text, voiceDescription: req.body?.voice_description, onProgress: (p) => broadcast(p) });
    res.json(job);
  });
  router.post('/projects/:id/assets/:aid/change-outfit', (req, res) => {
    const a = Assets.get(req.params.aid);
    if (!a || a.project_id !== req.params.id) return res.status(404).json({ error: '资产不存在' });
    if (a.category !== 'character') return res.status(400).json({ error: '只能对角色（人物）资产换装' });
    if (!req.body?.outfit) return res.status(400).json({ error: '缺少 outfit（服装描述）' });
    const job = startCostumeJob({ projectId: req.params.id, characterId: req.params.aid, outfit: req.body.outfit, prompt: req.body?.prompt, onProgress: (p) => broadcast(p) });
    res.json(job);
  });
  router.post('/projects/:id/assets/:aid/upload', express.raw({ type: 'application/octet-stream', limit: '100mb' }), (req, res) => {
    const asset = Assets.get(req.params.aid);
    if (!asset || asset.project_id !== req.params.id) return res.status(404).json({ error: '资产不存在' });
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: '缺少文件内容' });
    const orig = decodeURIComponent(String(req.headers['x-filename'] || ''));
    const extName = (orig && path.extname(orig) || '').toLowerCase();
    const isAudio = ['voice', 'music', 'sfx'].includes(asset.category);
    const isVideo = asset.category === 'video' || /\.(mp4|webm|mov|avi|mkv|m4v|gif)$/i.test(extName);
    const ext = extName || (isVideo ? '.mp4' : (isAudio ? '.wav' : '.png'));
    const subdir = PROJECT_ASSET_SUBDIRS[asset.category] || 'other';
    const rel = 'assets/' + subdir + '/' + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
    const abs = resolveProjectPath(req.params.id, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    if (asset.category === 'voice') Assets.update(asset.id, { voice_ref: rel, audio_path: rel, source: 'uploaded', status: 'done' });
    else if (isVideo) Assets.update(asset.id, { video_path: rel, source: 'uploaded', status: 'done' });
    else if (isAudio) Assets.update(asset.id, { audio_path: rel, source: 'uploaded', status: 'done' });
    else Assets.update(asset.id, { image_path: rel, source: 'uploaded', status: 'done' });
    res.json({ asset_id: asset.id, path: rel });
  });

  // ===== 分镜 =====
  router.get('/projects/:id/shots', (req, res) => res.json(Shots.list(req.params.id)));
  router.post('/projects/:id/shots/:sid/regenerate', (req, res) => {
    const shot = Shots.get(req.params.sid);
    if (!shot) return res.status(404).json({ error: '分镜不存在' });
    const job = startRegenerateJob({ projectId: req.params.id, shotId: req.params.sid, feedback: req.body?.feedback, onProgress: (p) => broadcast(p) });
    res.json(job);
  });
  // 打包下载所有单个视频片段（zip）
  router.get('/projects/:id/shots/zip', (req, res) => {
    try {
      const chapter = req.query?.chapter || '';
      let shots = Shots.list(req.params.id).filter((s) => s.video_path && s.status === 'done');
      if (chapter) shots = shots.filter((s) => s.chapter === chapter);
      if (!shots.length) return res.status(400).json({ error: chapter ? ('章节「' + chapter + '」没有已完成的视频片段') : '没有已完成的视频片段' });
      // 按章节 + 序号排序，保证解压后顺序稳定
      shots.sort((a, b) => {
        const ca = a.chapter || '', cb = b.chapter || '';
        if (ca !== cb) return ca < cb ? -1 : 1;
        return (a.idx ?? 0) - (b.idx ?? 0);
      });

      const zip = new AdmZip();
      const used = new Set();
      for (const s of shots) {
        const abs = resolveProjectPath(req.params.id, s.video_path);
        if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
        const ext = path.extname(s.video_path);
        const folder = slugify(s.chapter || '默认') || '默认';
        const scene = slugify(s.scene_name || '');
        const stem = String(s.idx ?? 0).padStart(3, '0') + (scene ? '_' + scene : '');
        let entryName = stem + ext;
        let n = 1;
        while (used.has(folder + '/' + entryName)) entryName = stem + '_' + (n++) + ext;
        used.add(folder + '/' + entryName);
        zip.addLocalFile(abs, folder, entryName);
      }
      if (!zip.getEntries().length) return res.status(500).json({ error: '视频片段文件缺失，无法打包' });

      const p = Projects.get(req.params.id);
      const zipBase = slugify(p?.name || 'project') + '_' + (chapter ? slugify(chapter) : '全部章节') + '_片段';
      const tmpPath = path.join(os.tmpdir(), zipBase + '_' + uid().slice(0, 8) + '.zip');
      zip.writeZip(tmpPath);
      res.download(tmpPath, zipBase + '.zip', (err) => {
        if (err && !res.headersSent) res.status(500).json({ error: err.message });
        fs.rm(tmpPath, { force: true }, () => {});
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  router.post('/projects/:id/export', async (req, res) => {
    try {
      const chapter = req.body?.chapter || req.query?.chapter || '';
      let done = Shots.list(req.params.id).filter((s) => s.video_path && s.status === 'done');
      if (chapter) done = done.filter((s) => s.chapter === chapter);
      if (!done.length) return res.status(400).json({ error: chapter ? ('章节「' + chapter + '」没有已完成的镜头') : '没有已完成的分镜' });
      done.sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
      const inputs = done.map((s) => resolveProjectPath(req.params.id, s.video_path)).filter(Boolean);
      const p = Projects.get(req.params.id);
      const base = chapter ? slugify(p.name) + '_' + slugify(chapter) : slugify(p.name);
      const outRel = 'exports/' + base + '_' + uid().slice(0, 8) + '.mp4';
      await mergeVideos(inputs, resolveProjectPath(req.params.id, outRel), {});
      res.json({ export_path: outRel, url: '/files/projects/' + req.params.id + '/' + outRel, shots: done.length, chapter });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===== 成片（导出视频） =====
  router.get('/projects/:id/exports', (req, res) => {
    const dir = path.join(projectDir(req.params.id), 'exports');
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(f))
        .map((f) => {
          const abs = path.join(dir, f);
          const st = fs.statSync(abs);
          return { name: f, rel: 'exports/' + f, url: '/files/projects/' + req.params.id + '/exports/' + f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {}
    res.json({ files });
  });
  router.get('/projects/:id/exports/:file/download', (req, res) => {
    const name = path.basename(req.params.file || '');
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return res.status(400).json({ error: '非法文件名' });
    const abs = path.join(projectDir(req.params.id), 'exports', name);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: '文件不存在' });
    res.download(abs, name);
  });

  // ===== 技能 =====
  router.get('/skills', (req, res) => res.json(Skills.list()));
  router.post('/skills/rescan', (req, res) => res.json(scanSkills()));
  // 上传 zip 技能包：解压含 SKILL.md / SKILL.cn.md 的目录到 skills/ 并重新扫描注册
  router.post('/skills/upload', express.raw({ type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'], limit: '50mb' }), (req, res) => {
    try {
      const buf = req.body;
      if (!buf || !buf.length) return res.status(400).json({ error: '缺少 zip 文件内容' });
      const filename = decodeURIComponent(String(req.headers['x-filename'] || ''));
      const installed = installSkillsFromZip(buf, { sourceName: filename });
      const skills = scanSkills();
      res.json({ installed, skills });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ===== 工作流（仅展示系统已注册，注册入口已移除）=====
  router.get('/workflows', (req, res) => res.json(Workflows.list()));

  return router;
}
