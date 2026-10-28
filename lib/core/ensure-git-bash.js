// Windows 上用 Start-Process / 服务方式后台启动时，进程往往拿不到用户终端里的 Git PATH；
// openclaude SDK 在找不到 git-bash 时会直接 process.exit(1)，表现为「服务刚起来就退出」。
// 这个模块必须在 lib/agent（及其 SDK）之前被 import：提前探测并注入 CLAUDE_CODE_GIT_BASH_PATH。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

if (process.platform === 'win32') {
  const exists = (p) => {
    try {
      return !!p && fs.existsSync(p);
    } catch {
      return false;
    }
  };

  let bash = process.env.CLAUDE_CODE_GIT_BASH_PATH || '';
  if (!exists(bash)) {
    const candidates = [];
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
    candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
    candidates.push('C:\\Program Files (x86)\\Git\\bin\\bash.exe');
    candidates.push('D:\\Git\\bin\\bash.exe');

    try {
      const out = execFileSync('where', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      for (const line of out.split(/\r?\n/)) {
        const gitExe = line.trim();
        if (!gitExe) continue;
        // D:\Git\cmd\git.exe -> D:\Git\bin\bash.exe
        // D:\Git\mingw64\bin\git.exe -> D:\Git\bin\bash.exe
        const dir = path.dirname(gitExe);
        candidates.push(path.join(dir, '..', 'bin', 'bash.exe'));
        candidates.push(path.join(dir, '..', '..', 'bin', 'bash.exe'));
      }
    } catch {
      // 没装 git / 不在 PATH：继续用候选路径兜底
    }

    bash = candidates.find(exists) || '';
  }

  if (bash) {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = bash;
    if (!process.env.SHELL) process.env.SHELL = bash;
  }
}
