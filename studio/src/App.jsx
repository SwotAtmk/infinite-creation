import { useEffect, useState } from 'react';
import { ToastProvider } from './components/toast.jsx';
import BackToTop from './components/BackToTop.jsx';
import TopBar from './components/TopBar.jsx';
import ProjectsPage from './pages/ProjectsPage.jsx';
import ProjectWorkspace from './pages/ProjectWorkspace.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import { useServerInfo } from './lib/hooks.js';

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
  const server = useServerInfo();
  const [features, setFeatures] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/app-info')
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        setFeatures(j.features || {});
        setReady(true);
      })
      .catch(() => {
        if (alive) {
          setFeatures({});
          setReady(true);
        }
      });

    const sync = () => setView(parseView());
    sync();
    window.addEventListener('popstate', sync);
    return () => {
      alive = false;
      window.removeEventListener('popstate', sync);
    };
  }, []);

  useEffect(() => {
    document.title = view.type === 'project' ? '项目 · 无限创作 Studio' : view.type === 'settings' ? '设置 · 无限创作 Studio' : '无限创作 Studio';
  }, [view]);

  const go = (v) => {
    window.history.pushState(null, '', urlFor(v));
    setView(v);
  };

  const setTab = (tab) => {
    setView((v) => {
      const nv = { ...v, tab };
      window.history.replaceState(null, '', urlFor(nv));
      return nv;
    });
  };

  const wide = view.type === 'project';

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="skeleton h-24 w-64 rounded-2xl" />
      </div>
    );
  }

  return (
    <ToastProvider>
      <div className="relative z-[1] flex min-h-screen flex-col">
        <TopBar
          view={view}
          onHome={() => go({ type: 'list' })}
          onSettings={() => go({ type: 'settings' })}
          serverInfo={server}
          features={features || {}}
          showSettings={!features || features.settings !== false}
        />
        <main className={wide ? 'mx-auto w-full max-w-[1360px] flex-1 px-5 py-6' : 'mx-auto w-full max-w-[1200px] flex-1 px-5 py-8'}>
          {view.type === 'list' ? (
            <ProjectsPage
              publicMode={server.publicMode}
              features={features || {}}
              onOpen={(id) => go({ type: 'project', id, tab: 'chapters' })}
            />
          ) : null}
          {view.type === 'project' ? (
            <ProjectWorkspace
              key={view.id}
              id={view.id}
              features={features || {}}
              initialTab={view.tab}
              onBack={() => go({ type: 'list' })}
              onTabChange={setTab}
            />
          ) : null}
          {view.type === 'settings' ? (
            <SettingsPage onBack={() => go({ type: 'list' })} publicMode={server.publicMode} />
          ) : null}
        </main>
        <footer className="mx-auto w-full max-w-[1360px] px-5 pb-6 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-4 text-[11px] text-[var(--fg-4)]">
            {server.publicMode ? (
              <>
                <span>托管服务 · 数据由服务端统一保存</span>
                <span>无限创作 Studio</span>
              </>
            ) : (
              <>
                <span>无限创作 Studio · 小说到成片的一站式 AI 创作平台</span>
                <span>内容由 AI 生成，请遵守平台规范与当地法律法规</span>
              </>
            )}
          </div>
        </footer>
        <BackToTop />
      </div>
    </ToastProvider>
  );
}
