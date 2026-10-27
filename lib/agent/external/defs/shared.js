// 外部 Agent 定义共用常量与工具。

export const MCP_SERVER_NAME = 'ic';

// 自定义命令参数分词：支持单/双引号与反斜杠转义，不做 shell 展开。
export function parseCustomArgs(input) {
  const s = String(input == null ? '' : input);
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
      cur += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}
