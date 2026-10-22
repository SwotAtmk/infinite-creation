// 上传 txt 小说文件，解析出正文文本（UTF-8），供创建项目时使用。
// 拆分章节仍在 POST /api/projects 里由 splitNovelIntoChapters 完成；这里只读文本，
// 顺带返回字数与章节数，供前端提示「将拆分为 N 章」。
import { NextResponse } from 'next/server';
import { splitNovelIntoChapters } from '@/lib/shared/index.js';

export const dynamic = 'force-dynamic';

const MAX_TXT_BYTES = 20 * 1024 * 1024; // 20MB

export async function POST(req) {
  const fd = await req.formData().catch(() => null);
  if (!fd) return NextResponse.json({ error: '缺少表单数据' }, { status: 400 });
  const file = fd.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return NextResponse.json({ error: '缺少文件' }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  if (!buf.length) return NextResponse.json({ error: '缺少文件内容' }, { status: 400 });
  if (buf.length > MAX_TXT_BYTES) return NextResponse.json({ error: '文件超过 20MB' }, { status: 400 });
  // UTF-8 读取并去掉 BOM（\uFEFF）
  const novel = buf.toString('utf8').replace(/^\uFEFF/, '');
  const chapters = splitNovelIntoChapters(novel);
  return NextResponse.json({ novel, chars: novel.length, chapterCount: chapters.length });
}
