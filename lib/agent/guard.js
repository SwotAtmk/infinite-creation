// 运行时安全守卫：在领域工具执行前扫描工具参数，拦截危险命令/危险参数。
//
// 定位：与「工具白名单」互补 —— canUseTool 白名单负责「拒绝未知工具」，
// 本模块负责「拒绝已知工具的危险参数」。只做静态模式匹配，不解析 shell，
// 也不执行任何命令；命中即拦截该次调用，由上层决定如何回传给 Agent。
//
// 拦截语义（分层，不终止任务）：命中只标记 blocked=true 并带 severity，
// 由调用方（tools.js::runTool）记录日志、回传「已拦截」结果，让 Agent 继续安全操作。

// 危险命令模式（参考通用高危命令清单，severity ∈ extreme/high）
// pattern 为 RegExp 构造入参字符串，统一忽略大小写匹配。
const DANGEROUS_PATTERNS = [
  { id: 'rm-rf', name: '递归强制删除（rm -rf）', severity: 'extreme', pattern: '\\brm\\s+-[a-zA-Z]*[rR][fF]\\b' },
  { id: 'dd-disk', name: 'dd 直写磁盘设备', severity: 'extreme', pattern: '\\bdd\\b[^;|&\\n]{0,120}\\bof=/dev/' },
  { id: 'mkfs', name: '格式化/分区（mkfs/fdisk/parted）', severity: 'extreme', pattern: '\\b(?:mkfs|fdisk|parted|mkswap|cfdisk|mkfs\\.\\w+)\\b' },
  { id: 'fork-bomb', name: 'fork bomb（进程炸弹）', severity: 'extreme', pattern: ':\\(\\)\\{[^}]*?:\\|:&\\};:' },
  { id: 'chmod-777', name: 'chmod 777（全员可写）', severity: 'high', pattern: '\\bchmod\\b[^;&\\n]{0,40}\\b777\\b' },
  { id: 'chmod-000', name: 'chmod 000（自我锁死）', severity: 'high', pattern: '\\bchmod\\b[^;&\\n]{0,40}\\b000\\b' },
  { id: 'sudo-su', name: '提权切换（sudo su / su -）', severity: 'high', pattern: '\\b(?:sudo\\s+su|sudo\\s+-i|sudo\\s+-s|su\\s+-|sudo\\s+root)\\b' },
  { id: 'pipe-sh', name: '网络下载直输 shell（curl|sh）', severity: 'high', pattern: '(?:curl|wget)\\b[^;|&\\n]{0,120}\\|\\s*(?:ba)?sh\\b' },
  { id: 'git-force', name: '版本历史破坏（git --force/reset --hard/clean）', severity: 'high', pattern: '\\bgit\\s+(?:push\\s+--force|reset\\s+--hard|clean\\s+-[a-zA-Z]*fdx|push\\s+-f)\\b' },
  { id: 'no-verify', name: '绕过钩子（--no-verify）', severity: 'high', pattern: '(?<![\\-\\w])--no-verify\\b' },
].map((r) => ({ ...r, regex: new RegExp(r.pattern, 'i') }));

// 认定为「文件路径」的参数名集合：仅对它们做路径穿越校验，避免对普通创意文本误报。
const PATH_ARG_KEYS = new Set([
  'voice_ref', 'reference_image_path', 'image_path', 'video_path', 'audio_path',
  'file_path', 'path', 'out_path',
]);

// 路径穿越判定：绝对路径，或按 /、\ 切分后含 .. 段。
export function isPathTraversal(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.startsWith('/')) return true;
  return value.replace(/\\/g, '/').split('/').includes('..');
}

function safeSerialize(args) {
  try {
    return JSON.stringify(args || {});
  } catch {
    return String(args);
  }
}

// 扫描一次工具调用：返回 { blocked, severity?, rule?, message? }
export function guardToolCall(name, args) {
  const text = safeSerialize(args);

  // 1) 危险命令模式：序列化整个参数对象后匹配。
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.regex.test(text)) {
      return { blocked: true, severity: rule.severity, rule: rule.id, message: '命中危险命令规则「' + rule.name + '」' };
    }
  }

  // 2) 路径穿越：仅对路径类参数做校验。
  for (const key of PATH_ARG_KEYS) {
    const v = args && args[key];
    if (typeof v === 'string' && isPathTraversal(v)) {
      return { blocked: true, severity: 'extreme', rule: 'path-traversal', message: '路径参数 ' + key + ' 存在越权（../ 或绝对路径）' };
    }
  }

  return { blocked: false };
}
