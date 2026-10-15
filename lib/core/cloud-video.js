import { logger } from './logger.js';
import { sleep } from './utils.js';
import { httpJson, httpGetBuffer, readMediaBase64, withRetry, abortedError, outItem,
         saveTempMedia, tolerantPick } from './cloud-api.js';

// host / model 一律从配置读，不硬编码
function videoApiCfg(cfg) {
  const c = cfg?.mediaApi?.video || {};
  const baseUrl = String(c.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(c.apiKey || '').trim();
  const model = String(c.model || '').trim();
  if (!baseUrl || !apiKey || !model) throw new Error('云端视频未配置（需要 baseUrl/apiKey/model）');
  return { baseUrl, apiKey, model };
}

// 中转站只接受这几个固定 size，请求方给的宽高要就近归档
const VIDEO_SIZES = ['1280x720', '720x1280', '1024x1024', '854x480', '480x854'];
const FALLBACK_SIZE = '1280x720';

// 解析 '16:9' / '9:16' / '1:1'，解不出返回 0
function parseAspectRatio(s) {
  const m = String(s || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i);
  if (!m) return 0;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : 0;
}

function minSide(sizeStr) {
  const [w, h] = String(sizeStr).split('x').map(Number);
  return Math.min(Number(w) || 0, Number(h) || 0);
}

// 纯函数：按宽高比就近匹配中转站支持的 size；480P 档只在两个 480 尺寸里挑；非法输入回落 1280x720
export function sizeForVideoApi(width, height, resolution, aspectRatio) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  // 显式宽高优先，其次 aspect_ratio，都没有按默认横屏 16:9
  let target = w > 0 && h > 0 ? w / h : parseAspectRatio(aspectRatio);
  if (!(target > 0)) target = 16 / 9;
  let pool = VIDEO_SIZES;
  if (String(resolution || '').trim().toUpperCase() === '480P') {
    const low = VIDEO_SIZES.filter((s) => minSide(s) === 480);
    if (low.length) pool = low;
  }
  let best = FALLBACK_SIZE;
  let bestDiff = Infinity;
  for (const s of pool) {
    const [sw, sh] = s.split('x').map(Number);
    if (!(sw > 0) || !(sh > 0)) continue;
    // 用对数差衡量比例接近度，横竖屏对称、不会因为比值大小偏向某一侧
    const diff = Math.abs(Math.log((sw / sh) / target));
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

// OpenAI 这个字段是字符串，且限 4~15 秒，缺省 6
function pickSeconds(params) {
  const n = Math.round(Number(params?.seconds) || 6);
  return String(Math.min(15, Math.max(4, n)));
}

// 任务 id 直接当文件名主体，先洗掉路径分隔符等非法字符
function safeName(id, ext) {
  return String(id || '').replace(/[^\w.-]/g, '_') + ext;
}

// 接口限制：input_reference 只收单个引用，因此只有第一张图能当首帧参考，
// 其余图片和所有音频/视频参考没有对应字段，只能跳过并 warn
async function buildInputReference(params) {
  const refs = Array.isArray(params?.references) ? params.references : [];
  const imgs = refs.filter((r) => r?.type === 'image');
  const audioN = refs.filter((r) => r?.type === 'audio').length;
  const videoN = refs.filter((r) => r?.type === 'video').length;
  if (imgs.length > 1) {
    logger.warn('云端视频接口的 input_reference 只支持单个参考图，已跳过 ' + (imgs.length - 1) + ' 张参考图');
  }
  if (audioN) {
    logger.warn('云端视频接口不支持参考音频，已跳过 ' + audioN
      + ' 段音色参考（角色音色一致性丢失，只能靠提示词里的声音描述兜底）');
  }
  if (videoN) {
    logger.warn('云端视频接口不支持参考视频，已跳过 ' + videoN + ' 段视频参考');
  }
  if (!imgs.length) return undefined; // 无参考图＝纯文生视频，不传该字段
  const m = await readMediaBase64(imgs[0].filename);
  return m.dataUri;
}

// 创建任务，返回厂商 id。withRetry 只在抛错（没拿到 id）时重试，401/403 不重试，避免重复提交
async function createVideoTask(vc, body) {
  return await withRetry(async () => {
    const j = await httpJson(vc.baseUrl + '/videos', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + vc.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 60_000);
    const id = tolerantPick(j, ['id', 'video_id', 'data.id', 'task_id', 'data.task_id']);
    if (!id) throw new Error('创建视频任务未返回 id：' + JSON.stringify(j).slice(0, 300));
    return String(id);
  }, { times: 3 });
}

async function queryVideoTask(vc, id) {
  const j = await withRetry(() => httpJson(vc.baseUrl + '/videos/' + encodeURIComponent(id), {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + vc.apiKey },
  }, 30_000), { times: 3 });
  return j || {}; // 状态/地址字段一律用 tolerantPick 容错取，不提前解包
}

// 成片地址：先试查询响应里直接给的 URL，没有再走 /content 接口。
// 两条路都「现在就带鉴权把字节取回落临时文件」：直链也可能是中转站托管的要密钥，
// 而下游 cloudDownload 不带鉴权头，返回远程 URL 会撞 401。落 file:// 与配音保持一致。
async function resolveVideoUrl(vc, id, task) {
  const auth = { Authorization: 'Bearer ' + vc.apiKey };
  const direct = tolerantPick(task, ['url', 'download_url', 'content.url', 'video_url', 'data.url', 'output.video_url']);
  const url = direct ? String(direct) : vc.baseUrl + '/videos/' + encodeURIComponent(id) + '/content';
  const buf = await withRetry(() => httpGetBuffer(url, 5 * 60_000, auth), { times: 3 });
  if (!buf || !buf.length) return '';
  return saveTempMedia(buf, '.mp4');
}

const DONE_STATUS = new Set(['completed', 'succeeded', 'success']);
const FAIL_STATUS = new Set(['failed', 'cancelled', 'canceled']);

// 提交 + 轮询 + 取成片。prompt_id = 厂商任务 id（调用方拿去取消）
export async function openaiGenerateVideo(cfg, params, opts = {}) {
  const vc = videoApiCfg(cfg);
  const body = {
    model: vc.model,
    prompt: String(params?.positive_prompt || ''),
    seconds: pickSeconds(params),
    size: sizeForVideoApi(params?.width, params?.height, params?.resolution, params?.aspect_ratio),
  };
  const inputReference = await buildInputReference(params);
  if (inputReference) body.input_reference = inputReference;

  try {
    const id = await createVideoTask(vc, body);
    opts.onSubmitted?.(id);
    opts.onStatus?.({ kind: 'queued', prompt_id: id });

    const timeoutMs = opts.timeoutMs ?? 90 * 60 * 1000; // 视频生成慢，缺省 90 分钟
    const pollMs = opts.pollMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (opts.isAborted?.()) throw abortedError();
      const task = await queryVideoTask(vc, id);
      const status = String(tolerantPick(task, ['status', 'data.status', 'task_status']) || '').toLowerCase();
      if (DONE_STATUS.has(status)) {
        const fileUrl = await resolveVideoUrl(vc, id, task);
        if (!fileUrl) throw new Error('视频任务成功但取不到成片地址：id=' + id);
        return { prompt_id: id, outputs: [outItem({ filename: safeName(id, '.mp4'), kind: 'videos', fileUrl })] };
      }
      if (FAIL_STATUS.has(status)) {
        const msg = tolerantPick(task, ['error.message', 'error', 'fail_msg', 'status_msg']) || status;
        throw new Error('云端视频任务失败：' + msg + '（id=' + id + '）');
      }
      await sleep(pollMs);
    }
    throw new Error('云端视频生成超时（' + Math.round(timeoutMs / 60000) + ' 分钟），id=' + id);
  } catch (e) {
    if (e?.interrupted) throw e; // 用户取消不算失败，不报 error 状态
    opts.onStatus?.({ kind: 'error', message: e?.message || String(e) });
    throw e;
  }
}
