// 无限・卷轴（小说结构大纲）：GET 读当前结构 / POST 生成 / PUT 保存用户编辑
import { NextResponse } from 'next/server';
import { Projects, Jobs, Chapters, withWriteContext, loadNovelState, saveNovelState, isValidNovelStep } from '@/lib/core/index.js';
import { startNovelJob, activeJobOf } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

function activeNovelJob(projectId) {
  return Jobs.list(projectId).find((j) => j.type === 'novel' && (j.status === 'running' || j.status === 'queued'));
}

export async function GET(_req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const state = loadNovelState(id);
  const active = activeNovelJob(id);
  const chapters = Chapters.list(id).map((c) => ({ id: c.id, title: c.title, seq: c.seq, volume: c.volume ?? 1, outline: c.outline || '', novel: c.novel, status: c.status }));
  return NextResponse.json({
    project: { id: p.id, name: p.name, idea: p.idea, type: p.type, status: p.status },
    ...state,
    chapters,
    activeJob: active ? { id: active.id, type: active.type, step: (active.checkpoint || {}).step, status: active.status } : null,
  });
}

// POST：触发 Agent 生成一层或全部层
export async function POST(req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (p.type !== 'novel') return NextResponse.json({ error: '这不是小说项目' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const step = String(body.step || 'all').toLowerCase();
  if (!isValidNovelStep(step)) return NextResponse.json({ error: '非法 step：' + step }, { status: 400 });

  const active = activeNovelJob(id);
  if (active) return NextResponse.json({ error: '该小说正在生成中，请等它结束或先停止', code: 'ALREADY_RUNNING', jobId: active.id }, { status: 409 });

  // 全部重新生成：先把已有的 大纲/角色/卷/章节/记忆 清空，再按 start 全流程重跑
  if (step === 'restart') {
    withWriteContext('POST /api/projects/:id/novel (restart)', () => {
      for (const c of Chapters.list(id)) Chapters.remove(c.id);
      saveNovelState(id, {
        structure: { outline: '', volumes: '', chapters: '' },
        characters: [],
        volumes: [],
        memory: [],
      });
    });
  }

  const job = startNovelJob({
    projectId: id,
    step: step === 'restart' ? 'start' : step,
    chapter: String(body.chapter || '').trim() || undefined,
    message: String(body.message || '').trim(),
    onProgress: (patch) => broadcast(patch),
  });
  return NextResponse.json(job);
}

// PUT：保存用户手动编辑的结构 / 角色 / 记忆
export async function PUT(req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (p.type !== 'novel') return NextResponse.json({ error: '这不是小说项目' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const { structure, characters, volumes, memory } = body;

  try {
    withWriteContext('PUT /api/projects/:id/novel', () => {
      saveNovelState(id, {
        structure: structure != null ? structure : undefined,
        characters: characters != null ? characters : undefined,
        volumes: volumes != null ? volumes : undefined,
        memory: memory != null ? memory : undefined,
      });
    });
  } catch (e) {
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }

  const state = loadNovelState(id);
  return NextResponse.json({ ok: true, ...state });
}
