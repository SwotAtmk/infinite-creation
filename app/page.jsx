'use client';
// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation

import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import BackToTop from './pages/BackToTop';
import ProjectsPage from './pages/ProjectsPage';
import ProjectView from './pages/ProjectView';
import SettingsPage from './pages/SettingsPage';
import ThemeToggle from './pages/ThemeToggle';
import { ToastProvider } from './toast';

// 视图 ↔ URL 双向同步：/?view=project&id=xxx&tab=yyy
// 刷新页面 / 浏览器前进后退都停留在原视图，不再跳回主页
function parseView() {
  const p = new URLSearchParams(window.location.search);
  const type = p.get('view');
  if (type === 'project') {
    const id = p.get('id');
    if (id) return { type: 'project', id, tab: p.get('tab') || 'chapters' };
  }
  if (type === 'settings') return { type: 'settings' };
  return { type: 'list' };
}
function urlFor(view) {
  if (view.type === 'project') {
    let u = '/?view=project&id=' + encodeURIComponent(view.id);
    if (view.tab) u += '&tab=' + encodeURIComponent(view.tab);
    return u;
  }
  if (view.type === 'settings') return '/?view=settings';
  return '/';
}

export default function App() {
  const [view, setView] = useState({ type: 'list' });

  // 挂载后按 URL 恢复视图；浏览器前进/后退时同步
  useEffect(() => {
    const sync = () => setView(parseView());
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  // 打开项目/设置/返回列表：pushState 推进历史，浏览器后退可返回上一视图
  const go = (v) => {
    window.history.pushState(null, '', urlFor(v));
    setView(v);
  };
  // tab 切换：replaceState 只更新 URL 供刷新恢复，不占历史
  const setTab = (tab) => {
    setView((v) => {
      const nv = { ...v, tab };
      window.history.replaceState(null, '', urlFor(nv));
      return nv;
    });
  };

  return (
    <ToastProvider>
      <div className="max-w-[1100px] mx-auto px-5 py-5">
        <div className="row justify-between mb-6">
          <h1 className="text-2xl font-semibold m-0">
            Agent无限创作 <span className="muted">小说 → 视频 · 全自动 Agent · 项目地址：</span>{' '}
            <a href="https://github.com/SwotAtmk/infinite-creation" target="_blank" rel="noreferrer" className="no-underline" style={{ marginLeft: 10, fontSize: 13 }}>SwotAtmk/infinite-creation</a>
          </h1>
          <div className="row">
            <ThemeToggle />
            <Button onPress={() => go({ type: 'settings' })}>⚙ 设置</Button>
          </div>
        </div>
        {view.type === 'list' && <ProjectsPage onOpen={(id) => go({ type: 'project', id, tab: 'chapters' })} />}
        {view.type === 'project' && <ProjectView id={view.id} initialTab={view.tab} onBack={() => go({ type: 'list' })} onTabChange={setTab} />}
        {view.type === 'settings' && <SettingsPage onBack={() => go({ type: 'list' })} />}
        <BackToTop />
      </div>
    </ToastProvider>
  );
}