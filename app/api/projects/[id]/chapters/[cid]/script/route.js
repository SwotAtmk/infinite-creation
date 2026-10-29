// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, Projects, loadConfig, llmChat, buildChapterScriptMessages, withWriteContext } from '@/lib/core/index.js';
import { activeJobOfChapter } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// AI 剧本生成 / 改写：同步调用 LLM，结果直接落库（前端「AI 生成/改写」不需要再点一次保存）。
// 与章节 PATCH 同口径：本章正在跑任务时拒绝写入，避免任务用旧剧本回写分镜。
export async function POST(req, { params }) {
  const { id, cid } = await params;
  const body = await req.json().catch(() => ({}));
  const mode = body?.mode === 'rewrite' ? 'rewrite' : 'generate';
  const instruction = String(body?.instruction || '').trim();

  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const chapter = Chapters.get(cid);
  if (!chapter || chapter.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  if (activeJobOfChapter(id, chapter.title)) {
    return NextResponse.json({ error: '本章正在运行任务，运行中不可改写剧本；请等任务结束或先停止本章' }, { status: 409 });
  }

  const cfg = loadConfig();
  if (!cfg?.llm?.baseUrl) return NextResponse.json({ error: '未配置 LLM Base URL，请先到「设置」里配置。' }, { status: 400 });

  const novel = String(chapter.novel || '').trim();
  const script = String(chapter.script || '').trim();
  const idea = String(p.idea || '').trim();
  if (mode === 'rewrite' && !script) {
    return NextResponse.json({ error: '本章还没有剧本，请先用「生成」或手动编写' }, { status: 400 });
  }
  if (mode === 'generate' && !novel && !idea) {
    return NextResponse.json({ error: '本章没有小说原文，也没有项目想法，无法生成剧本' }, { status: 400 });
  }

  const messages = buildChapterScriptMessages({
    chapterTitle: chapter.title,
    novel,
    idea,
    style: p.style,
    script,
    instruction,
    mode,
  });

  let out;
  try {
    out = await llmChat(cfg.llm, messages, { temperature: 0.6, maxTokens: 8192, timeoutMs: 300000 });
  } catch (e) {
    return NextResponse.json({ error: 'AI 生成失败：' + (e?.message || e) }, { status: 502 });
  }
  const next = String(out?.content || '').trim();
  if (!next) return NextResponse.json({ error: 'AI 返回空剧本，请重试' }, { status: 502 });

  const saved = withWriteContext('POST /api/projects/:id/chapters/:cid/script', () => Chapters.update(cid, { script: next }));
  const text = String(saved?.script ?? next);
  return NextResponse.json({ mode, script: text, chars: text.length, saved: true });
}
