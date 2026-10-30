// 开源版本地部署没有登录/宿主会话，媒体 URL 直接使用。
export function withSession(url) {
  return url;
}

export function fileUrl(projectId, rel) {
  if (!rel) return null;
  return withSession('/files/projects/' + projectId + '/' + rel);
}

export function fmtRelative(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(a, b) {
  if (!a || !b || b < a) return '';
  const s = Math.round((b - a) / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ' 分' + (r ? r + ' 秒' : '');
}

export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(i ? 1 : 0) + ' ' + u[i];
}

export function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// 文件名形如「项目名_第1章_uid.mp4」：把章节提到标题最前面，其余交给省略号截断
export function exportTitle(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  const m = base.match(/第[0-9一二三四五六七八九十百零两]+章/);
  if (!m) return base;
  const rest = base.replace(m[0], '').replace(/^_+|_+$/g, '');
  return rest ? m[0] + ' · ' + rest : m[0];
}

export const STATUS_TEXT = {
  idle: '空闲',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  pending: '待生成',
  generating: '生成中',
  queued: '排队中',
  cancelled: '已取消',
  interrupted: '已中断',
};

export function statusTone(status) {
  if (status === 'done' || status === 'success') return 'success';
  if (status === 'failed' || status === 'error') return 'danger';
  if (status === 'running' || status === 'generating') return 'accent';
  if (status === 'queued') return 'info';
  return 'neutral';
}

export const JOB_LABEL = {
  create: '生成流水线',
  regenerate: '重生成分镜',
  'asset-image': '资产出图',
  'voice-design': '音色设计',
  costume: '换装',
  age: '年龄变体',
  stage: '阶段运行',
  'chapter-video': '章节视频重生成',
  llm: '素材命名（LLM）',
  export: '导出成片',
  music: '生成背景音乐',
  'music-apply': '应用背景音乐',
  'voice-clone': '音色克隆',
  'digital-human-tts': '数字人语音驱动',
};

export const CANCELLABLE = new Set([
  'create',
  'regenerate',
  'asset-image',
  'voice-design',
  'costume',
  'age',
  'stage',
  'chapter-video',
  'music',
  'music-apply',
  'voice-clone',
  'digital-human-tts',
]);

export const JOB_STATUS_META = {
  running: { label: '执行中', tone: 'accent' },
  queued: { label: '排队中', tone: 'info' },
  done: { label: '完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
  interrupted: { label: '已中断', tone: 'neutral' },
};
