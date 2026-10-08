import fs from 'node:fs';
import { spawn } from 'node:child_process';

// 子进程超时兜底：ffmpeg/ffprobe 假死（磁盘慢、文件损坏、锁死）时 close 事件永不触发，
// Promise 永不 settle → assemble_video/mergeVideos 卡死 → job 永不结束 → 停止按钮常亮。
// 统一在超时后 SIGKILL 强杀并 reject；kill 后还会再触发一次 close，用 settled 守卫去重。
function runCapture(bin, args, { timeoutMs = 60_000, onLog, captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let settled = false;
    let killer; // 定义在 fail 之后，运行时只被异步事件访问，必已赋值
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(killer); reject(e); };
    const done = (v) => { if (settled) return; settled = true; clearTimeout(killer); resolve(v); };
    killer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      fail(new Error(bin + ' 执行超时（' + Math.round(timeoutMs / 1000) + 's），已强制终止。请检查磁盘空间与源文件是否损坏。'));
    }, timeoutMs);
    p.stderr.on('data', (d) => { const s = d.toString(); stderr += s; if (onLog) onLog(s); });
    if (captureStdout) p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.on('error', (e) => fail(new Error(bin + ' 启动失败: ' + e.message)));
    p.on('close', (code) => {
      if (code === 0) done(captureStdout ? stdout : undefined);
      else fail(new Error(bin + (code === null ? ' 被强制终止' : ' 退出码 ' + code) + (stderr ? '：' + stderr.slice(-2000) : '')));
    });
  });
}

export function runFfmpeg(args, { onLog, timeoutMs = 10 * 60 * 1000 } = {}) {
  return runCapture('ffmpeg', args, { timeoutMs, onLog });
}

async function probeVideo(inputPath, timeoutMs = 20_000) {
  const out = await runCapture('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', inputPath], { timeoutMs, captureStdout: true });
  try {
    const j = JSON.parse(out);
    const s = (j.streams && j.streams[0]) || {};
    return { width: s.width || 0, height: s.height || 0 };
  } catch {
    throw new Error('ffprobe 解析失败: ' + inputPath);
  }
}

export async function mergeVideos(inputPaths, outputPath, { onLog } = {}) {
  if (!inputPaths.length) throw new Error('没有可合并的视频');
  if (inputPaths.length === 1) { fs.copyFileSync(inputPaths[0], outputPath); return; }

  let tw = 0, th = 0;
  for (const p of inputPaths) {
    const { width, height } = await probeVideo(p);
    if (width > tw) tw = width;
    if (height > th) th = height;
  }
  if (!tw || !th) throw new Error('无法探测视频分辨率');
  tw = tw % 2 ? tw + 1 : tw;
  th = th % 2 ? th + 1 : th;

  const n = inputPaths.length;
  const args = ['-y'];
  for (const p of inputPaths) args.push('-i', p);

  const vLabels = []; const aLabels = []; const chains = [];
  for (let i = 0; i < n; i++) {
    const v = 'v' + i, a = 'a' + i;
    chains.push('[' + i + ':v]scale=' + tw + ':' + th + ':force_original_aspect_ratio=decrease,pad=' + tw + ':' + th + ':(ow-iw)/2:(oh-ih)/2:color=black,fps=24,format=yuv420p,setpts=PTS-STARTPTS[' + v + ']');
    chains.push('[' + i + ':a]aresample=44100,asetpts=PTS-STARTPTS[' + a + ']');
    vLabels.push(v); aLabels.push(a);
  }
  const concatInputs = [];
  for (let i = 0; i < n; i++) concatInputs.push('[' + vLabels[i] + ']', '[' + aLabels[i] + ']');
  const filter = chains.join(';') + ';' + concatInputs.join('') + 'concat=n=' + n + ':v=1:a=1[vout][aout]';

  args.push('-filter_complex', filter, '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-r', '24', '-movflags', '+faststart', outputPath);

  await runFfmpeg(args, { onLog });
}