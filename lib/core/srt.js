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

// 单镜字幕文本：台词（去掉「人物：」前缀，字幕里不出现角色名）在上，旁白在下；
// 空行丢弃，避免破坏 SRT 条目结构。
function subtitleText(shot) {
  const parts = [];
  for (const src of [shot.dialogue, shot.narration]) {
    const lines = String(src || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      // 「林默：你好」/「甲，乙：你好」→ 只留冒号后的台词。限长 32 字，避免把
      // 带冒号的整句叙述（如「他说：走吧」）之外的长句误当说话人标签。
      .map((l) => l.replace(/^[^：:]{1,32}[：:]\s*/, '').trim())
      .filter(Boolean);
    if (lines.length) parts.push(lines.join('\n'));
  }
  return parts.join('\n');
}

// 分镜数组（按叙事顺序）-> SRT 全文。
// 每镜占满它的 duration：即使该镜没有台词/旁白也照样推进时间轴（视频片段仍在播放），
// 只是不产出空 cue。整段都没有文本时返回 ''（调用方据此决定不写文件）。
export function buildSrt(shots) {
  const cues = [];
  let cursor = 0;
  for (const shot of shots || []) {
    if (!shot) continue;
    const dur = Number(shot.duration) > 0 ? Number(shot.duration) : SHOT_DURATION_DEFAULT;
    const start = cursor;
    cursor += dur;
    const text = subtitleText(shot);
    if (!text) continue;
    cues.push({ index: cues.length + 1, start, end: cursor, text });
  }
  if (!cues.length) return '';
  return cues.map((c) => c.index + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text + '\n').join('\n');
}
