// 字幕（SRT）生成：把分镜的台词/旁白按「每镜 duration 累计」排成时间轴。
//
// 为什么不用 ASR：分镜的 dialogue / narration 本来就是流水线写好的剧本文本，
// H3 也是拿 shot.duration 作为 seconds 出片，成片时长与分镜时长基本一致——
// 直接复用剧本文本即可，无需再引入语音识别模型。
import { SHOT_DURATION_DEFAULT } from './shot-write.js';

// 秒 -> SRT 时间戳 "HH:MM:SS,mmm"
export function srtTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const ms = Math.round(total * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + pad(milli, 3);
}

// 单镜里的每句文本：台词去掉「人物：」前缀（字幕里不出现角色名），旁白原样保留。
// 一行一句，便于逐句分配时间轴——把多句挤进同一条 cue 会让烧录后的字幕在画面里换行。
function subtitleLines(shot) {
  const out = [];
  for (const src of [shot.dialogue, shot.narration]) {
    String(src || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      // 「林默：你好」/「甲，乙：你好」→ 只留冒号后的台词。限长 32 字，避免把
      // 带冒号的整句叙述（如「他说：走吧」）之外的长句误当说话人标签。
      .map((l) => l.replace(/^[^：:]{1,32}[：:]\s*/, '').trim())
      .filter(Boolean)
      .forEach((l) => out.push(l));
  }
  return out;
}

// 分镜数组（按叙事顺序）-> SRT 全文。
// 每镜占满它的 duration：即使该镜没有台词/旁白也照样推进时间轴（视频片段仍在播放），
// 只是不产出空 cue。整段都没有文本时返回 ''（调用方据此决定不写文件）。
// 镜内多句台词按字数比例分配该镜时长，每句一条 cue（单行），避免一条字幕里堆多行文字。
export function buildSrt(shots) {
  const cues = [];
  let cursor = 0;
  for (const shot of shots || []) {
    if (!shot) continue;
    const dur = Number(shot.duration) > 0 ? Number(shot.duration) : SHOT_DURATION_DEFAULT;
    const start = cursor;
    cursor += dur;
    const lines = subtitleLines(shot);
    if (!lines.length) continue;
    const weights = lines.map((l) => Math.max(1, l.length));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = start;
    for (let i = 0; i < lines.length; i++) {
      const end = i === lines.length - 1 ? cursor : t + (dur * weights[i]) / total;
      cues.push({ index: cues.length + 1, start: t, end, text: lines[i] });
      t = end;
    }
  }
  if (!cues.length) return '';
  return cues.map((c) => c.index + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text + '\n').join('\n');
}
