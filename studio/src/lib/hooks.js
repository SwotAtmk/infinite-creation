import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// 后端在线状态 + 是否公开托管模式（公开模式下隐藏管理员设置）
export function useServerInfo() {
  const [info, setInfo] = useState({ online: true, publicMode: false });
  useEffect(() => {
    let alive = true;
    const ping = () =>
      api
        .get('/api/health')
        .then((r) => alive && setInfo({ online: !!r.ok, publicMode: !!r.publicMode }))
        .catch(() => alive && setInfo({ online: false, publicMode: false }));
    ping();
    const t = setInterval(ping, 20000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return info;
}

// 兼容旧调用
export function useHealth() {
  return useServerInfo().online;
}

// 防止异步回调在组件卸载后 setState（React 18 不再告警，但会丢逻辑一致性）
export function useMountedRef() {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

// 项目流程进度：一次返回四个阶段的 done/total/todo/percent 与章节级进度。
// 运行中每 2.5s 刷新，空闲时放慢到 8s；WS 消息到达时由调用方主动 refresh。
export function useProjectProgress(projectId, active) {
  const [progress, setProgress] = useState(null);
  const load = useCallback(() => {
    if (!projectId) return Promise.resolve(null);
    return api
      .get('/api/projects/' + projectId + '/progress')
      .then((p) => {
        setProgress(p);
        return p;
      })
      .catch(() => null);
  }, [projectId]);

  useEffect(() => {
    load();
    const t = setInterval(load, active ? 2500 : 8000);
    return () => clearInterval(t);
  }, [load, active]);

  return { progress, refreshProgress: load };
}

// 创建项目 / 长操作的全屏阻断层
export function useBusy() {
  const [busy, setBusy] = useState(null);
  const run = async (text, fn) => {
    setBusy(text);
    try {
      return await fn();
    } finally {
      setBusy(null);
    }
  };
  return { busy, setBusy, run };
}

// 拖拽上传的通用状态
export function useDropFiles(onFiles) {
  const [over, setOver] = useState(false);
  const bind = {
    onDragOver: (e) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: (e) => {
      e.preventDefault();
      setOver(false);
    },
    onDrop: (e) => {
      e.preventDefault();
      setOver(false);
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) onFiles(files);
    },
  };
  return { over, bind };
}
