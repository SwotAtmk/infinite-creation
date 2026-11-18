// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { loadConfig, saveConfig, HW_PRESETS, hardwareMode } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const PUBLIC_MODE = process.env.IC_PUBLIC === '1';

// 恢复默认工作流：把指定 kind（或全部）的 config.workflows[kind] 重置为当前硬件模式预设。
export async function POST(req) {
  if (PUBLIC_MODE) return NextResponse.json({ error: '公开模式下不允许修改配置' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const cfg = loadConfig();
  const preset = HW_PRESETS[hardwareMode(cfg)] || {};
  const targets = body?.kind ? [body.kind] : Object.keys(preset);
  const workflows = { ...(cfg.workflows || {}) };
  for (const k of targets) {
    if (preset[k] !== undefined) workflows[k] = preset[k];
  }
  const saved = saveConfig({ ...cfg, workflows });
  return NextResponse.json({ ok: true, workflows: saved.workflows, kind: body?.kind || null });
}
