// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { loadConfig, saveConfig, Jobs, Queue } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

// 对 C 端开放时设置环境变量 IC_PUBLIC=1：
//   · GET 不再返回任何密钥（RunningHub / LLM），页面被外网用户打开始终拿不到 Key；
//   · PUT 直接拒绝，避免外部用户覆盖或清空服务端配置。
// 密钥只在服务端 config.json / 生成请求内部使用，不会经由本接口下发到浏览器。
const PUBLIC_MODE = process.env.IC_PUBLIC === '1';

function redactConfig(cfg) {
  return {
    ...cfg,
    comfyui: { ...(cfg.comfyui || {}), apiKey: '' },
    llm: { ...(cfg.llm || {}), apiKey: '' },
  };
}

export async function GET() {
  const cfg = loadConfig();
  return NextResponse.json(PUBLIC_MODE ? redactConfig(cfg) : cfg);
}

export async function PUT(req) {
  if (PUBLIC_MODE) {
    return NextResponse.json({ error: '公开模式下不允许通过接口修改配置' }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  // PUT 是整段覆盖：空对象 / 空请求体会把密钥与全部配置写成默认值。
  // 前端两个设置界面都会提交完整配置，所以这里拒绝明显错误的空载荷。
  const SECTIONS = ['server', 'comfyui', 'llm', 'hardware', 'generation', 'workflows', 'features', 'debug'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || !SECTIONS.some((k) => k in body)) {
    return NextResponse.json({ error: '配置内容为空，已拒绝写入' }, { status: 400 });
  }
  // 切换执行端（本地 ComfyUI ↔ 云端渲染）时不允许有活动任务：
  // 否则旧队列条目会留在 DB 里、新 provider 的调度器不接管，任务会永远排队；
  // 运行中的任务也可能一半走本地、一半走云端。
  const oldCfg = loadConfig();
  const oldProvider = oldCfg?.comfyui?.provider === 'runninghub' ? 'runninghub' : 'native';
  const nextProvider = body?.comfyui?.provider === 'runninghub' ? 'runninghub' : 'native';
  if (oldProvider !== nextProvider) {
    const activeJobs = Jobs.list().filter((j) => j.status === 'running' || j.status === 'queued').length;
    const activeQueue = Queue.running().length + Queue.waiting().length;
    if (activeJobs || activeQueue) {
      return NextResponse.json({
        error: '当前还有 ' + activeJobs + ' 个运行中任务、' + activeQueue + ' 个排队条目。切换执行端会混用本地与云端，请先停止任务或等完成后再切换。',
        code: 'PROVIDER_BUSY',
      }, { status: 409 });
    }
    // 没有活动任务时清掉旧 provider 遗留的队列条目，避免切换后永远排队。
    try { Queue.cancelAllPending('切换执行端'); } catch { /* 忽略 */ }
  }
  return NextResponse.json(saveConfig(body));
}
