// Studio 开发启动器：
//   node scripts/dev.mjs               前台常驻：同时启动后端（4610）与 Studio（4710），日志直接输出到终端
//   node scripts/dev.mjs --background  后台启动：调用 start-studio.sh / start-studio.bat，日志写入文件后退出
//   pnpm run dev:classic               经典界面（单端口 4600）
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const script = path.join(root, win ? 'start-studio.bat' : 'start-studio.sh');

const BACKEND_PORT = Number(process.env.STUDIO_BACKEND_PORT || process.env.BACKEND_PORT || 4610);
const STUDIO_PORT = Number(process.env.STUDIO_PORT || 4710);

if (process.argv.includes('--background')) {
  // 后台启动：交给仓库根目录的启动脚本，日志重定向到 logs/ 下的文件后脚本退出
  const child = win
    ? spawn(script, { cwd: root, stdio: 'inherit', shell: true })
    : spawn('bash', [script], { cwd: root, stdio: 'inherit' });
  child.on('error', (err) => {
    console.error('[错误] 启动 Studio 失败：' + err.message);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code == null ? 1 : code));
} else {
  runForeground();
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(800, () => done(false));
  });
}

const children = [];
let stopping = false;

function run(name, command, args, env, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: !!options.shell,
  });
  children.push(child);
  child.on('error', (err) => {
    console.error('\r\n[dev] ' + name + ' 启动失败：' + err.message);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.log('\r\n[dev] ' + name + ' 已退出（' + (code == null ? signal : 'code ' + code) + '），正在停止其余进程…');
    stopAll(code == null ? 1 : code);
  });
  return child;
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode == null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // 已退出
      }
    }
  }
  setTimeout(() => process.exit(code), 1200);
}

process.on('SIGINT', () => {
  console.log('\r\n[dev] 收到 Ctrl+C，正在停止…');
  stopAll(0);
});
process.on('SIGTERM', () => stopAll(0));

async function runForeground() {
  console.log('============================================');
  console.log('  infinite-creation Studio 开发模式（前台）');
  console.log('============================================');
  console.log('  Studio   http://127.0.0.1:' + STUDIO_PORT);
  console.log('  后端     http://127.0.0.1:' + BACKEND_PORT);
  console.log('  日志直接输出到当前终端，Ctrl+C 同时停止两者');
  console.log('');

  if (await portInUse(BACKEND_PORT)) {
    console.log('[dev] 后端 ' + BACKEND_PORT + ' 已在运行，直接复用');
  } else {
    run('Studio 后端', process.execPath, ['server.js'], {
      PORT: String(BACKEND_PORT),
      BACKEND_PORT: String(BACKEND_PORT),
      NEXT_DIST_DIR: process.env.NEXT_DIST_DIR || '.next-studio-dev',
      HOST: '0.0.0.0',
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
    });
  }

  if (await portInUse(STUDIO_PORT)) {
    console.log('[dev] Studio ' + STUDIO_PORT + ' 已在运行，直接复用');
  } else {
    run(
      'Studio 前端',
      'pnpm',
      ['--filter', 'studio', 'dev'],
      {
        STUDIO_PORT: String(STUDIO_PORT),
        STUDIO_BACKEND: 'http://127.0.0.1:' + BACKEND_PORT,
      },
      { shell: win },
    );
  }

  if (!children.length) {
    console.log('[dev] 两个服务都已在运行，无需再启动。需要实时日志请先执行 ./stop-studio.sh 再重新启动。');
    process.exit(0);
  }
}
