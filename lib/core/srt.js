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

// 估算「这句话说完要多久」：按中文字幕常用语速（约 5 字/秒）折算，并给一个最短停留时间，
// 让很短的一句（「嗯」「好」）也能看清。字幕只在这段时间内显示，说完就消失——
// 不再占满整个分镜（分镜尾部没说话的空白期不该还挂着上一句台词）。
const SPEECH_RATE = 5;      // 字/秒
const MIN_CUE_SEC = 0.8;    // 单句最短显示时长

// 分镜数组（按叙事顺序）-> SRT 全文。
// 每镜的 duration 照常推进时间轴（没说话的镜头也不产出空 cue），
// 镜内多句台词按各自的「说完所需时长」顺序排布，每句一条 cue（单行）。
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
    const spans = lines.map((l) => Math.max(MIN_CUE_SEC, l.length / SPEECH_RATE));
    const total = spans.reduce((a, b) => a + b, 0);
    // 台词总时长超出本镜时按比例压缩，保证字幕不会越到下一个分镜
    const scale = total > dur ? dur / total : 1;
    let t = start;
    for (let i = 0; i < lines.length; i++) {
      const span = spans[i] * scale;
      cues.push({ index: cues.length + 1, start: t, end: t + span, text: lines[i] });
      t += span;
    }
  }
  if (!cues.length) return '';
  return cues.map((c) => c.index + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text + '\n').join('\n');
}
