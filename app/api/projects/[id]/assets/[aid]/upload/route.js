// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Assets, Queue, slugify, uid, resolveProjectPath } from '@/lib/core/index.js';
import { PROJECT_ASSET_SUBDIRS, uploadMediaKind, UPLOAD_MAX_BYTES } from '@/lib/shared/index.js';

export const dynamic = 'force-dynamic';

// 超限一律 413，并说明该类素材的上限，用户才知道该压到多大
function tooLarge(limit) {
  return NextResponse.json({ error: '文件过大：这类素材上限 ' + Math.round(limit / 1024 / 1024) + 'MB' }, { status: 413 });
}

export async function POST(req, { params }) {
  const { id, aid } = await params;
  const asset = Assets.get(aid);
  if (!asset || asset.project_id !== id) return NextResponse.json({ error: '资产不存在' }, { status: 404 });
  // 正在出图 / 设计音色时替换文件，会和任务回写互相覆盖；等渲染完成再替换。
  const busy = Queue.activeByDedupe('asset:' + aid) || Queue.activeByDedupe('voice:' + aid);
  if (busy) {
    return NextResponse.json(
      { error: '该素材正在生成中，暂时不能替换；请等渲染完成后再上传', code: 'ALREADY_RENDERING', jobId: busy.jobId },
      { status: 409 },
    );
  }
  // 文件名头由客户端编码（界面用 encodeURIComponent）。非法转义（如单个 '%'）会让
  // decodeURIComponent 抛 URIError，本路由原先没有 try/catch → 未捕获异常 → 500。
  let orig = '';
  try { orig = decodeURIComponent(req.headers.get('x-filename') || ''); }
  catch { return NextResponse.json({ error: 'X-Filename 不是合法的 URL 编码' }, { status: 400 }); }
  const extName = (orig && path.extname(orig) || '').toLowerCase();
  // 媒体判定统一走 shared 的 uploadMediaKind（分类优先 + 扩展名兜底）：上传框不限类型，
  // 只看 category 会把 .mp3 当图片存进 image_path、把 .gif 当视频存进 video_path
  //（<video> 根本放不出 gif，素材又没有 image_path 可当参考图）。
  const kind = uploadMediaKind({ category: asset.category, ext: extName });
  const isAudio = kind === 'audio';
  const isVideo = kind === 'video';
  const ext = extName || (isVideo ? '.mp4' : (isAudio ? '.wav' : '.png'));
  // 体积上限：整个请求体要读进内存，所以先按 Content-Length 早退（连正文都不读），
  // 读完再按实际长度兜一道（分块上传没有该头）。
  const limit = UPLOAD_MAX_BYTES[kind];
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > limit) return tooLarge(limit);
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return NextResponse.json({ error: '缺少文件内容' }, { status: 400 });
  if (buf.length > limit) return tooLarge(limit);
  const subdir = PROJECT_ASSET_SUBDIRS[asset.category] || 'other';
  const rel = 'assets/' + subdir + '/' + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
  const abs = resolveProjectPath(id, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  if (asset.category === 'voice') Assets.update(asset.id, { voice_ref: rel, audio_path: rel, source: 'uploaded', status: 'done' });
  else if (isVideo) Assets.update(asset.id, { video_path: rel, source: 'uploaded', status: 'done' });
  else if (isAudio) Assets.update(asset.id, { audio_path: rel, source: 'uploaded', status: 'done' });
  else Assets.update(asset.id, { image_path: rel, source: 'uploaded', status: 'done' });
  return NextResponse.json({ asset_id: asset.id, path: rel });
}
