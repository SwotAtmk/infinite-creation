'use client';
// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation

import { useState } from 'react';
import { Button } from '@heroui/react';
import BackToTop from './pages/BackToTop';
import ProjectsPage from './pages/ProjectsPage';
import ProjectView from './pages/ProjectView';
import SettingsPage from './pages/SettingsPage';
import ThemeToggle from './pages/ThemeToggle';
import { ToastProvider } from './toast';

export default function App() {
  const [view, setView] = useState({ type: 'list' });
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
            <Button onPress={() => setView({ type: 'settings' })}>⚙ 设置</Button>
          </div>
        </div>
        {view.type === 'list' && <ProjectsPage onOpen={(id) => setView({ type: 'project', id })} />}
        {view.type === 'project' && <ProjectView id={view.id} onBack={() => setView({ type: 'list' })} />}
        {view.type === 'settings' && <SettingsPage onBack={() => setView({ type: 'list' })} />}
        <BackToTop />
      </div>
    </ToastProvider>
  );
}