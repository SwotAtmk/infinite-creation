// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { Projects, projectDir, withWriteContext } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

// 项目上下文（人物圣经 / 风格指南 / 连续性记录）。写入语义与内置 Agent 的 save_context 完全一致：
// context 表存 JSON，同时落盘 context/*.md，保证「界面/API 写入」与「Agent 写入」产物一致。
export const CONTEXT_KEYS = ['bible', 'style', 'continuity'];

export async function GET(_req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  return NextResponse.json(p?.context || {});
}

export async function PUT(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });

  // 两种入参都支持：{ key, content }（与 save_context 对齐）与 { bible?, style?, continuity? } 批量
  const writes = [];
  if (body && typeof body.key === 'string') {
    if (!CONTEXT_KEYS.includes(body.key)) return NextResponse.json({ error: 'key 只能是 bible/style/continuity' }, { status: 400 });
    writes.push({ key: body.key, content: String(body.content ?? '') });
  } else if (body && typeof body === 'object') {
    for (const k of CONTEXT_KEYS) if (body[k] !== undefined) writes.push({ key: k, content: String(body[k] ?? '') });
  }
  if (!writes.length) return NextResponse.json({ error: '缺少可写入内容（key+content 或 bible/style/continuity）' }, { status: 400 });

  return withWriteContext('PUT /api/projects/:id/context', async () => {
    const dir = path.join(projectDir(id), 'context');
    fs.mkdirSync(dir, { recursive: true });
    const ctxObj = { ...(p.context || {}) };
    for (const { key, content } of writes) {
      if (key === 'continuity') {
        // 连续性记录是追加式日志（与 save_context 一致）：读旧数组 → push → 整体写回
        const f = path.join(dir, 'continuity.json');
        let arr = [];
        try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { arr = []; }
        if (!Array.isArray(arr)) arr = [];
        arr.push({ t: Date.now(), content });
        fs.writeFileSync(f, JSON.stringify(arr, null, 2));
      } else {
        fs.writeFileSync(path.join(dir, key === 'bible' ? 'bible.md' : 'style.md'), content);
      }
      ctxObj[key] = content;
    }
    const updated = Projects.update(id, { context: ctxObj });
    return NextResponse.json({ ok: true, context: updated?.context || ctxObj, keys: writes.map((w) => w.key) });
  });
}
