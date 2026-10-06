'use client';
// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation

import { useState } from 'react';
import BackToTop from './pages/BackToTop';
import ProjectsPage from './pages/ProjectsPage';
import ProjectView from './pages/ProjectView';
import SettingsPage from './pages/SettingsPage';
import { ToastProvider } from './toast';

export default function App() {
  const [view, setView] = useState({ type: 'list' });
  return (
    <ToastProvider>
      <div className="container">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>
          Agent无限创作 <span className="muted">小说 → 视频 · 全自动 Agent · 项目地址：</span>{' '}
          <a href="https://github.com/SwotAtmk/infinite-creation" target="_blank" rel="noreferrer" className="muted" style={{ marginLeft: 10, fontSize: 13, textDecoration: 'none' }}>SwotAtmk/infinite-creation</a>
        </h1>
        <button onClick={() => setView({ type: 'settings' })}>⚙ 设置</button>
      </div>
      {view.type === 'list' && <ProjectsPage onOpen={(id) => setView({ type: 'project', id })} />}
      {view.type === 'project' && <ProjectView id={view.id} onBack={() => setView({ type: 'list' })} />}
      {view.type === 'settings' && <SettingsPage onBack={() => setView({ type: 'list' })} />}
      <BackToTop />
      </div>
    </ToastProvider>
  );
}