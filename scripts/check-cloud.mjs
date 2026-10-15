// 云端接口冒烟测试：真调付费接口，逐条验证「编剧大模型 / 配音 / 生图 / 图生图 / 视频」通不通，
// 产物落在 data/smoke/ 下可以直接打开看和听。
//
// 走的是项目里的真实代码路径（lib/core/cloud-api.js 等），不是另写一套请求，
// 所以这个脚本绿了就代表正式生成流程也能跑通。
//
// 用法：
//   node scripts/check-cloud.mjs                 # 配置检查 + 编剧 + 配音 + 生图 + 图生图（花费小，约 1 分钟）
//   node scripts/check-cloud.mjs --video         # 再加跑视频（慢，几分钟起）
//   node scripts/check-cloud.mjs --only tts      # 只跑指定项，逗号分隔
//   node scripts/check-cloud.mjs --list          # 看有哪些项
//
// 注意：本脚本不需要把 config.json 的 provider 改成 api，它直接调云端适配层。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, DATA_DIR } from '../lib/core/config.js';
import { cloudGenerate, cloudDownload, cloudCheck } from '../lib/core/cloud-api.js';
import { CLOUD_API_SPECS } from '../lib/core/workflow-specs.js';
import { llmChat } from '../lib/core/llm.js';

const OUT_DIR = path.join(DATA_DIR, 'smoke');
const ok = (s) => console.log('  \u2713 ' + s);
const bad = (s) => console.log('  \u2717 ' + s);
const info = (s) => console.log('    ' + s);

// 产物存盘并返回可读路径；文件名带时间戳，便于对比多次跑的结果
async function saveArtifact(fileUrl, stage, ext) {
  const buf = await cloudDownload(fileUrl);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const name = stage + '_' + new Date().toISOString().replace(/[:.]/g, '-') + ext;
  const abs = path.join(OUT_DIR, name);
  fs.writeFileSync(abs, buf);
  return { abs, bytes: buf.length };
}

// 把适配层的进度事件打到控制台，长任务（视频）不至于看起来像卡死
function statusPrinter(stage) {
  return (s) => {
    if (s?.kind === 'queued') info('[' + stage + '] 已提交，任务号 ' + s.prompt_id);
    else if (s?.kind === 'progress') info('[' + stage + '] ' + (s.message || '生成中…'));
    else if (s?.kind === 'error') info('[' + stage + '] 报错：' + s.message);
  };
}

const cloudOpts = (stage, extra = {}) => ({ onStatus: statusPrinter(stage), isAborted: () => false, ...extra });

// —— 各条链路 ——

const STAGES = [
  {
    key: 'config',
    title: '配置齐全检查（不花钱）',
    run: async (cfg) => {
      const r = await cloudCheck(cfg);
      if (!r.ok) throw new Error(r.error);
      if (!String(cfg.llm?.apiKey || '').trim()) throw new Error('缺少编剧大模型密钥（llm.apiKey）');
      info('生图：' + cfg.mediaApi.image.model + ' @ ' + cfg.mediaApi.image.baseUrl);
      info('视频：' + cfg.mediaApi.video.model + ' @ ' + cfg.mediaApi.video.baseUrl);
      info('配音：' + cfg.mediaApi.tts.model + ' @ ' + cfg.mediaApi.tts.baseUrl);
      info('编剧：' + cfg.llm.model + ' @ ' + cfg.llm.baseUrl);
      if (cfg.mediaApi.tts.voiceId) info('提示：填了固定音色 ID，角色的音色描述会被忽略');
      return '四套配置都填齐了';
    },
  },
  {
    key: 'llm',
    title: '编剧大模型（一句话，花费极小）',
    run: async (cfg) => {
      // 额度要给足：mimo 这类推理模型会先花 token「思考」，给少了正文就是空的
      const r = await llmChat(cfg.llm, [{ role: 'user', content: '只回复两个字：收到' }], { maxTokens: 2000, timeoutMs: 120_000 });
      const text = String(r.content || '').trim();
      const reasoning = String(r.message?.reasoning_content || '').trim();
      if (!text) {
        throw new Error('模型回了空内容（finishReason=' + r.finishReason
          + (reasoning ? '，思考过程吃了 ' + reasoning.length + ' 字，说明额度不够' : '') + '）');
      }
      if (reasoning) info('这是推理型模型，会先输出一段思考（本次 ' + reasoning.length + ' 字），额度要给足');
      return '模型回复：' + text.slice(0, 40);
    },
  },
  {
    key: 'tts',
    title: '配音（一句台词，存成 mp3 可以听）',
    run: async (cfg) => {
      const params = {
        text: '夜色渐深，他推开门，屋里一个人也没有。',
        voice_description: '中年男性，嗓音低沉沙哑，语气克制而疲惫',
      };
      const { prompt_id, outputs } = await cloudGenerate(cfg, CLOUD_API_SPECS.tts, params, cloudOpts('tts'));
      const out = outputs.find((o) => o.kind === 'audio');
      if (!out) throw new Error('配音没返回音频产物，任务号 ' + prompt_id);
      const f = await saveArtifact(out.fileUrl, 'tts', '.mp3');
      info('音色描述：' + params.voice_description);
      info('台词：' + params.text);
      return '存好了 ' + (f.bytes / 1024).toFixed(0) + ' KB → ' + f.abs;
    },
  },
  {
    key: 'image',
    title: '生图（一张 1024x1024，存成 png 可以看）',
    run: async (cfg, ctx) => {
      const params = {
        positive_prompt: '一位三十岁左右的东方女性，穿深色风衣，站在雨后的老巷口，电影感打光，写实风格',
        width: 1024,
        height: 1024,
      };
      const { prompt_id, outputs } = await cloudGenerate(cfg, CLOUD_API_SPECS.t2i, params, cloudOpts('image'));
      const out = outputs.find((o) => o.kind === 'images');
      if (!out) throw new Error('生图没返回图片产物，任务号 ' + prompt_id);
      const f = await saveArtifact(out.fileUrl, 'image', '.png');
      ctx.imagePath = f.abs; // 供图生图那一步当参考图
      return '存好了 ' + (f.bytes / 1024).toFixed(0) + ' KB → ' + f.abs;
    },
  },
  {
    key: 'i2i',
    title: '图生图（拿上一步的图改，验证参考图直传）',
    needs: 'image',
    run: async (cfg, ctx) => {
      if (!ctx.imagePath) throw new Error('没有可用的参考图，请先跑 image 这一项');
      const params = {
        positive_prompt: '把她的风衣换成红色，其余保持不变',
        image: ctx.imagePath,
        width: 1024,
        height: 1024,
      };
      const { outputs } = await cloudGenerate(cfg, CLOUD_API_SPECS.i2i, params, cloudOpts('i2i'));
      const out = outputs.find((o) => o.kind === 'images');
      if (!out) throw new Error('图生图没返回图片产物');
      const f = await saveArtifact(out.fileUrl, 'i2i', '.png');
      return '存好了 ' + (f.bytes / 1024).toFixed(0) + ' KB → ' + f.abs;
    },
  },
  {
    key: 'video',
    title: '视频（4 秒，慢且较贵，默认不跑）',
    run: async (cfg, ctx) => {
      const params = {
        positive_prompt: '镜头缓慢推进，雨后老巷，霓虹倒影在地面积水上晃动',
        seconds: 4,
        width: 1280,
        height: 720,
        aspect_ratio: '16:9',
        resolution: '720P',
        // 拿生图的产物当首帧参考，顺带验证参考图能传上去
        references: ctx.imagePath ? [{ type: 'image', filename: ctx.imagePath }] : [],
      };
      const { prompt_id, outputs } = await cloudGenerate(cfg, CLOUD_API_SPECS.r2v, params,
        cloudOpts('video', { pollMs: 5000, timeoutMs: 30 * 60 * 1000 }));
      const out = outputs.find((o) => o.kind === 'videos');
      if (!out) throw new Error('视频没返回成片产物，任务号 ' + prompt_id);
      const f = await saveArtifact(out.fileUrl, 'video', '.mp4');
      return '存好了 ' + (f.bytes / 1024 / 1024).toFixed(1) + ' MB → ' + f.abs;
    },
  },
];

// —— 命令行解析 ——

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;
const withVideo = argv.includes('--video');

if (argv.includes('--list')) {
  console.log('可跑的项目：');
  for (const s of STAGES) console.log('  ' + s.key.padEnd(8) + s.title);
  process.exit(0);
}

const picked = STAGES.filter((s) => {
  if (only) return only.includes(s.key);
  if (s.key === 'video') return withVideo;
  return true;
});
// 图生图依赖生图的产物：显式只跑 i2i 时把 image 补上
if (picked.some((s) => s.key === 'i2i') && !picked.some((s) => s.key === 'image')) {
  picked.splice(picked.findIndex((s) => s.key === 'i2i'), 0, STAGES.find((s) => s.key === 'image'));
}

console.log('云端接口冒烟测试');
console.log('会真的调用付费接口（视频那项最贵），产物存到 ' + OUT_DIR);
console.log('本次要跑：' + picked.map((s) => s.key).join(' → '));
console.log('');

const cfg = loadConfig();
const ctx = {};
const results = [];

for (const stage of picked) {
  const t0 = Date.now();
  console.log('· ' + stage.title);
  try {
    const msg = await stage.run(cfg, ctx);
    ok(msg + '（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）');
    results.push({ key: stage.key, pass: true });
  } catch (e) {
    bad((e?.message || String(e)) + '（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）');
    if (e?.status) info('HTTP 状态码：' + e.status);
    results.push({ key: stage.key, pass: false, error: e?.message || String(e) });
  }
  console.log('');
}

const passed = results.filter((r) => r.pass).length;
console.log('———————————————————————');
console.log('结果：' + passed + ' / ' + results.length + ' 项通过');
for (const r of results.filter((x) => !x.pass)) console.log('  失败：' + r.key + ' — ' + r.error.slice(0, 160));
if (passed === results.length) console.log('产物目录：' + OUT_DIR + '（图片和 mp3 可以直接打开验收）');
// 用 exitCode 而不是 process.exit()：后者会在 Windows 上触发 libuv 断言，打出一行吓人的报错
process.exitCode = passed === results.length ? 0 : 1;
