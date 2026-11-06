// 字幕环境 / 模型的安装入口。真正的下载与 pip 在后台任务里跑，前端轮询 /api/subtitle/status 拿进度。
import { NextResponse } from 'next/server';
import { SUBTITLE_MODELS, startEnvInstall, startModelDownload, cancelSubtitleTask } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const PUBLIC_MODE = process.env.IC_PUBLIC === '1';

export async function POST(req) {
  if (PUBLIC_MODE) {
    return NextResponse.json({ error: '公开模式下不允许修改本机字幕环境' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const target = String(body?.target || '');
  try {
    if (target === 'cancel') {
      return NextResponse.json({ cancelled: cancelSubtitleTask() });
    }
    if (target === 'env') {
      return NextResponse.json({ started: true, task: startEnvInstall() });
    }
    if (target === 'model') {
      const model = String(body?.model || '');
      if (!SUBTITLE_MODELS[model]) {
        return NextResponse.json({ error: '未知字幕模型：' + model }, { status: 400 });
      }
      return NextResponse.json({ started: true, task: startModelDownload(model) });
    }
    return NextResponse.json({ error: '参数 target 必须是 env / model / cancel' }, { status: 400 });
  } catch (e) {
    if (e.code === 'SUBTITLE_BUSY') {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
