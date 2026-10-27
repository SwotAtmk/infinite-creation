'use client';
// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation

import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import BackToTop from './pages/BackToTop';
import ProjectsPage from './pages/ProjectsPage';
import ProjectView from './pages/ProjectView';
import SettingsPage from './pages/SettingsPage';
import ThemeToggle from './pages/ThemeToggle';
import ImageGenPage from './pages/ImageGenPage';
import VideoGenPage from './pages/VideoGenPage';
import MusicGenPage from './pages/MusicGenPage';
import VoiceDesignPage from './pages/VoiceDesignPage';
import DigitalHumanPage from './pages/DigitalHumanPage';
import { ToastProvider } from './toast';

// 首页左侧菜单：不同类型对应不同工作台页面。
const MENU = [
  { id: 'projects', label: '项目列表' },
  { id: 'agent', label: 'Agent无限创作' },
  { id: 'digital_human', label: '数字人' },
  { id: 'image', label: '图片生成' },
  { id: 'video', label: '视频生成' },
  { id: 'music', label: '音乐生成' },
  { id: 'tts', label: '音色设计' },
];

// 视图 ↔ URL 双向同步：/?mode=xxx（简单模式）或 /?mode=agent&view=project&id=xxx&tab=yyy
function parseState() {
  const p = new URLSearchParams(window.location.search);
  const mode = MENU.some((m) => m.id === p.get('mode')) ? p.get('mode') : 'agent';
  let view = { type: 'list' };
  if (mode === 'agent' && p.get('view') === 'project' && p.get('id')) {
    view = { type: 'project', id: p.get('id'), tab: p.get('tab') || 'chapters' };
  }
  return { mode, view };
}
function urlFor(state) {
  if (state.mode !== 'agent') return '/?mode=' + encodeURIComponent(state.mode);
  if (state.view.type === 'project') {
    let u = '/?mode=agent&view=project&id=' + encodeURIComponent(state.view.id);
    if (state.view.tab) u += '&tab=' + encodeURIComponent(state.view.tab);
    return u;
  }
  return '/?mode=agent';
}

export default function App() {
  const [state, setState] = useState({ mode: 'agent', view: { type: 'list' } });
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 挂载后按 URL 恢复；浏览器前进/后退时同步
  useEffect(() => {
    const sync = () => setState(parseState());
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  // 打开项目/返回列表：pushState 推进历史
  const go = (v) => { window.history.pushState(null, '', urlFor(v)); setState(v); };
  // 切换左侧菜单：pushState，重置回列表
  const goMode = (mode) => { const s = { mode, view: { type: 'list' } }; window.history.pushState(null, '', urlFor(s)); setState(s); };
  // tab 切换：replaceState 只更新 URL 供刷新恢复，不占历史
  const setTab = (tab) => {
    setState((v) => { const nv = { ...v, view: { ...v.view, tab } }; window.history.replaceState(null, '', urlFor(nv)); return nv; });
  };

  const mode = state.mode;
  const title = (MENU.find((m) => m.id === mode) || {}).label || 'Agent无限创作';

  return (
    <ToastProvider>
      <div className="max-w-[1200px] mx-auto px-5 py-5">
        <div className="row justify-between mb-6">
          <h1 className="text-2xl font-semibold m-0">
            {title}{' '}
            <span className="muted">小说 → 视频 · 全自动 Agent</span>{' '}
            <a href="https://github.com/SwotAtmk/infinite-creation" target="_blank" rel="noreferrer" aria-label="GitHub" className="github-logo" style={{ marginLeft: 10, fontSize: 18 }} />
            <a href="https://github.com/SwotAtmk/infinite-creation" target="_blank" rel="noreferrer" className="no-underline" style={{ marginLeft: 10, fontSize: 13 }}>SwotAtmk/infinite-creation</a>
          </h1>
          <div className="row">
            <ThemeToggle />
            <Button onPress={() => setSettingsOpen(true)}>⚙ 设置</Button>
          </div>
        </div>

        <div className="flex gap-4 items-start">
          <aside className="w-52 shrink-0 sticky top-4 rounded-xl border border-default-200 bg-default-50 p-3 flex flex-col gap-1">
            {/* 分组标题：小号、浅色、带下分隔线，和下面的菜单项（可点击）明确区分开 */}
            <div className="px-3 pt-1 pb-2 mb-1 text-xs font-medium tracking-wider text-default-500 border-b border-default-200 select-none">菜单</div>
            {MENU.map((m) => (
              <button
                key={m.id}
                onClick={() => goMode(m.id)}
                className={'text-left px-3 py-2 rounded-lg text-sm border-0 cursor-pointer transition-colors ' + (mode === m.id ? 'bg-primary text-primary-foreground' : 'bg-transparent text-foreground hover:bg-default-100')}
              >{m.label}</button>
            ))}
          </aside>

          <main className="flex-1 min-w-0">
            {mode === 'agent' && state.view.type === 'list' && <ProjectsPage type="agent" onOpen={(p) => go({ mode: 'agent', view: { type: 'project', id: p.id, tab: 'chapters' } })} />}
            {mode === 'projects' && <ProjectsPage showCreate={false} showTypeFilter onOpen={(p) => ((p.type || 'agent') === 'agent' ? go({ mode: 'agent', view: { type: 'project', id: p.id, tab: 'chapters' } }) : goMode(p.type))} />}
            {mode === 'agent' && state.view.type === 'project' && <ProjectView id={state.view.id} initialTab={state.view.tab} onBack={() => go({ mode: 'agent', view: { type: 'list' } })} onTabChange={setTab} />}
            {mode === 'digital_human' && <DigitalHumanPage />}
            {mode === 'image' && <ImageGenPage />}
            {mode === 'video' && <VideoGenPage />}
            {mode === 'music' && <MusicGenPage />}
            {mode === 'tts' && <VoiceDesignPage />}
            {settingsOpen && <SettingsPage onBack={() => setSettingsOpen(false)} />}
            <BackToTop />
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
