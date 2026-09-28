import fs from 'node:fs';
import { spawn } from 'node:child_process';

export function runFfmpeg(args, { onLog } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { const s = d.toString(); stderr += s; if (onLog) onLog(s); });
    p.on('error', (e) => reject(new Error('ffmpeg 启动失败: ' + e.message)));
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg 退出码 ' + code + '：' + stderr.slice(-2000)));
    });
  });
}

function probeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', inputPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', (e) => reject(new Error('ffprobe 启动失败: ' + e.message)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe 探测失败: ' + inputPath));
      try {
        const j = JSON.parse(out);
        const s = (j.streams && j.streams[0]) || {};
        resolve({ width: s.width || 0, height: s.height || 0 });
      } catch { reject(new Error('ffprobe 解析失败: ' + inputPath)); }
    });
  });
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
