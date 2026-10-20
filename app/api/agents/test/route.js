import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/core/index.js';
import { findAgentDef, customAgentDef, resolveBin, probeVersion } from '@/lib/agent/external/index.js';

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const cfg = loadConfig();
  const id = String(body.agentId || cfg.agent?.runtime || 'openclaude');
  if (id === 'openclaude') return NextResponse.json({ ok: true, builtin: true, version: null });

  const def = id === 'custom' ? customAgentDef(body.custom || cfg.agent?.custom || {}) : findAgentDef(id);
  if (!def) return NextResponse.json({ error: '未知 Agent：' + id }, { status: 400 });
  if (!def.bin) return NextResponse.json({ ok: false, error: '未填写可执行文件' });

  const path = await resolveBin(def, cfg.agent?.extraPath || '');
  if (!path) return NextResponse.json({ ok: false, error: '未找到可执行文件：' + def.bin });
  const version = await probeVersion(path, def.versionArgs, cfg.agent?.extraPath || '');
  return NextResponse.json({ ok: true, path, version });
}
