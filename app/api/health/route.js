// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/core/index.js';
import { queueEnabled } from '@/lib/core/scheduler.js';
import { renderConcurrencyLimit } from '@/lib/core/render-gate.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  // publicMode：前端据此隐藏管理员级设置（密钥、工作流、硬件适配、技能管理）。
  // render：只暴露执行端与有效并发，不含任何密钥；用于顶栏显示当前实际调用的是本地还是云端。
  let render = null;
  try {
    const cfg = loadConfig();
    const provider = cfg?.comfyui?.provider === 'runninghub' ? 'runninghub' : 'native';
    render = {
      provider,
      label: provider === 'runninghub' ? '云端渲染' : '本地 ComfyUI',
      concurrency: renderConcurrencyLimit(cfg),
      configuredConcurrency: provider === 'runninghub'
        ? Math.max(1, Number(cfg?.generation?.runninghubConcurrency) || 1)
        : Math.max(1, Number(cfg?.generation?.videoConcurrency) || 1),
      queueEnabled: queueEnabled(cfg),
    };
  } catch {
    /* 配置读取失败不影响健康检查 */
  }
  return NextResponse.json({ ok: true, publicMode: process.env.IC_PUBLIC === '1', render });
}
