import { logger } from './logger.js';
import { httpJson, withRetry, abortedError, outItem, saveTempMedia, tolerantPick } from './cloud-api.js';

// host / model / voiceId 一律从配置读，不硬编码
function ttsApiCfg(cfg) {
  const c = cfg?.mediaApi?.tts || {};
  const baseUrl = String(c.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(c.apiKey || '').trim();
  const model = String(c.model || '').trim();
  if (!baseUrl || !apiKey || !model) throw new Error('云端语音未配置（需要 baseUrl/apiKey/model）');
  return { baseUrl, apiKey, model, voiceId: String(c.voiceId || '').trim() };
}

const FALLBACK_VOICE_DESC = '自然清晰的中文播音腔，语速平稳，情绪平和';

// 小米 MiMo 的约定：user 放音色描述（style prompt），assistant 放要朗读的文本，不能颠倒
function buildMessages(params) {
  const voice = String(params?.voice_description || '').trim();
  const text = String(params?.text || '').trim();
  if (!voice) logger.warn('未提供音色描述，已用中性播音腔兜底');
  return [
    { role: 'user', content: voice || FALLBACK_VOICE_DESC },
    { role: 'assistant', content: text },
  ];
}

// voicedesign 模型靠自然语言描述生成音色，传预设 voice 反而会冲突
function buildAudioField(tc) {
  const audio = { format: 'mp3' };
  if (tc.voiceId && !/voicedesign/i.test(tc.model)) audio.voice = tc.voiceId;
  return audio;
}

// 音频字段位置各家实现不一，按可能性从高到低逐个试
const AUDIO_FIELDS = [
  { path: 'choices.0.message.audio.data', kind: 'data' },
  { path: 'choices.0.message.audio.url', kind: 'url' },
  { path: 'data.audio', kind: 'data' },
  { path: 'audio.data', kind: 'data' },
  { path: 'audio', kind: 'data' },
  { path: 'choices.0.message.audio_content', kind: 'data' },
];

function pickAudio(j) {
  for (const f of AUDIO_FIELDS) {
    const v = tolerantPick(j, [f.path]);
    if (v === undefined || v === null || v === '') continue;
    if (f.kind === 'url') return { kind: 'url', value: String(v) };
    if (typeof v === 'string' || typeof v === 'number') return { kind: 'data', value: String(v) };
    // 命中了对象（比如 audio: { format }）说明这层没有音频本体，继续往下找
  }
  return null;
}

// 各家编码不一：纯十六进制串（偶数长度）按 hex 解，其余按 base64。
// 不能「先 base64、空了再 hex」——hex 串的字符全在 base64 字母表里，会被误解成非空乱码。
function decodeAudio(str) {
  const s = String(str || '').trim();
  if (!s) return Buffer.alloc(0);
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) return Buffer.from(s, 'hex');
  return Buffer.from(s, 'base64');
}

// 任务 id 直接当文件名主体，先洗掉 '/' 等非法字符
function safeName(id, ext) {
  return String(id || '').replace(/[^\w.-]/g, '_') + ext;
}

// chat/completions 同步接口：一次请求直接返回音频，不需要轮询
export async function mimoGenerateTts(cfg, params, opts = {}) {
  const tc = ttsApiCfg(cfg);
  if (opts.isAborted?.()) throw abortedError();
  const body = { model: tc.model, messages: buildMessages(params), audio: buildAudioField(tc) };
  try {
    const j = await withRetry(() => httpJson(tc.baseUrl + '/chat/completions', {
      method: 'POST',
      // 两种鉴权头都发：不同来源说法不一，同时发最保险
      headers: {
        'api-key': tc.apiKey,
        Authorization: 'Bearer ' + tc.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 120_000), { times: 3 });

    // HTTP 200 也可能业务失败，必须查 error / base_resp
    const bizMsg = tolerantPick(j, ['error.message', 'base_resp.status_msg']);
    if (bizMsg) throw new Error('小米 MiMo 语音合成失败：' + bizMsg);

    const promptId = String(tolerantPick(j, ['id', 'trace_id', 'data.trace_id']) || '') || ('tts_' + Date.now());
    opts.onSubmitted?.(promptId);
    opts.onStatus?.({ kind: 'queued', prompt_id: promptId });

    const hit = pickAudio(j);
    if (!hit) throw new Error('小米 MiMo 语音合成响应里找不到音频字段：' + JSON.stringify(j).slice(0, 300));
    let fileUrl = '';
    if (hit.kind === 'url') {
      fileUrl = hit.value;
    } else {
      const buf = decodeAudio(hit.value);
      if (!buf.length) throw new Error('小米 MiMo 语音合成返回空音频');
      // 音频在响应体里、没有 fileUrl：落临时 mp3，用 file:// 供调用方下载；写完不删，由系统清理
      fileUrl = saveTempMedia(buf, '.mp3');
    }

    return {
      prompt_id: promptId,
      outputs: [outItem({ filename: safeName(promptId, '.mp3'), kind: 'audio', fileUrl })],
    };
  } catch (e) {
    if (e?.interrupted) throw e; // 用户取消不算失败，不报 error 状态
    opts.onStatus?.({ kind: 'error', message: e?.message || String(e) });
    throw e;
  }
}
