import { useEffect, useState } from 'react';
import { Github, Image as ImageIcon, LayoutGrid, Mic2, Music4, Sparkles, UserRound, Video } from 'lucide-react';
import { ToastProvider } from './components/toast.jsx';
import BackToTop from './components/BackToTop.jsx';
import TopBar from './components/TopBar.jsx';
import ProjectsPage from './pages/ProjectsPage.jsx';
import ProjectWorkspace from './pages/ProjectWorkspace.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import DigitalHumanPage from './pages/DigitalHumanPage.jsx';
import ImageGenPage from './pages/ImageGenPage.jsx';
import VideoGenPage from './pages/VideoGenPage.jsx';
import MusicGenPage from './pages/MusicGenPage.jsx';
import VoiceDesignPage from './pages/VoiceDesignPage.jsx';
import { useServerInfo } from './lib/hooks.js';

// 左侧菜单：与经典界面保持一致，每种创作类型对应一个独立工作台。
const MENU = [
  { id: 'projects', label: '作品集', icon: LayoutGrid },
  { id: 'agent', label: 'Agent无限创作', icon: Sparkles },
  { id: 'digital_human', label: '数字人', icon: UserRound },
  { id: 'image', label: '图片生成', icon: ImageIcon },
  { id: 'video', label: '视频生成', icon: Video },
  { id: 'music', label: '音乐生成', icon: Music4 },
  { id: 'tts', label: '音色设计', icon: Mic2 },
];

function parseState() {
  const p = new URLSearchParams(window.location.search);
  const rawMode = p.get('mode');
  const mode = MENU.some((m) => m.id === rawMode) ? rawMode : 'agent';
  if (p.get('view') === 'project' && mode === 'agent' && p.get('id')) {
    return { mode, view: { type: 'project', id: p.get('id'), tab: p.get('tab') || 'chapters' } };
  }
  if (p.get('view') === 'settings') return { mode, view: { type: 'settings' } };
  return { mode, view: { type: 'list' } };
}

function urlFor(state) {
  const q = new URLSearchParams();
  if (state.mode !== 'agent') q.set('mode', state.mode);
  if (state.view.type === 'project') {
    q.set('view', 'project');
    q.set('id', state.view.id);
    if (state.view.tab) q.set('tab', state.view.tab);
  } else if (state.view.type === 'settings') {
    q.set('view', 'settings');
  }
  const s = q.toString();
  return '/' + (s ? '?' + s : '');
}

export default function App() {
  const [state, setState] = useState({ mode: 'agent', view: { type: 'list' } });
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

    const sync = () => setState(parseState());
    sync();
    window.addEventListener('popstate', sync);
    return () => {
      alive = false;
      window.removeEventListener('popstate', sync);
    };
  }, []);

  const title = (MENU.find((m) => m.id === state.mode) || {}).label || '无限创作 Studio';

  useEffect(() => {
    if (state.view.type === 'project') document.title = '项目 · 无限创作 Studio';
    else if (state.view.type === 'settings') document.title = '设置 · 无限创作 Studio';
    else document.title = title + ' · 无限创作 Studio';
  }, [state, title]);

  const go = (v) => {
    window.history.pushState(null, '', urlFor(v));
    setState(v);
  };

  const goMode = (mode) => go({ mode, view: { type: 'list' } });

  const setTab = (tab) => {
    setState((v) => {
      const nv = { ...v, view: { ...v.view, tab } };
      window.history.replaceState(null, '', urlFor(nv));
      return nv;
    });
  };

  const openProject = (id) => go({ mode: 'agent', view: { type: 'project', id, tab: 'chapters' } });
  // 所有项目列表中：Agent 项目进项目页，其余类型切到对应工作台（与经典界面一致）
  const openFromAll = (project) => {
    if ((project.type || 'agent') === 'agent' || !project.type) openProject(project.id);
    else goMode(project.type);
  };

  const publicMode = !!server.publicMode;

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
          view={state.view}
          onHome={() => goMode('agent')}
          onSettings={() => go({ ...state, view: { type: 'settings' } })}
          serverInfo={server}
          showSettings={!features || features.settings !== false}
        />

        <main className="mx-auto w-full max-w-[1360px] flex-1 px-5 py-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
            <aside className="w-full shrink-0 lg:sticky lg:top-[84px] lg:w-[212px]">
              <nav className="panel p-2">
                <p className="section-label px-2.5 pb-1.5 pt-2">创作菜单</p>
                <div className="flex gap-0.5 overflow-x-auto lg:flex-col lg:overflow-visible">
                  {MENU.map((m) => {
                    const Icon = m.icon;
                    const active = state.mode === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        data-active={active}
                        className="nav-item w-auto shrink-0 lg:w-full"
                        onClick={() => goMode(m.id)}
                      >
                        <Icon size={15} className={active ? 'text-[var(--accent)]' : 'text-[var(--fg-3)]'} />
                        <span className="flex-1 whitespace-nowrap text-left">{m.label}</span>
                      </button>
                    );
                  })}
                </div>
              </nav>
            </aside>

            <div className="min-w-0 flex-1">
              {state.view.type === 'settings' ? (
                <SettingsPage onBack={() => go({ ...state, view: { type: 'list' } })} publicMode={publicMode} />
              ) : null}

              {state.view.type !== 'settings' && state.mode === 'projects' ? (
                <ProjectsPage
                  showCreate={false}
                  showTypeFilter
                  publicMode={publicMode}
                  features={features || {}}
                  onOpen={(p) => openFromAll(p)}
                />
              ) : null}

              {state.view.type !== 'settings' && state.mode === 'agent' && state.view.type === 'list' ? (
                <ProjectsPage
                  type="agent"
                  publicMode={publicMode}
                  features={features || {}}
                  onOpen={(p) => openProject(p.id)}
                />
              ) : null}

              {state.view.type !== 'settings' && state.mode === 'agent' && state.view.type === 'project' ? (
                <ProjectWorkspace
                  key={state.view.id}
                  id={state.view.id}
                  features={features || {}}
                  initialTab={state.view.tab}
                  onBack={() => go({ mode: 'agent', view: { type: 'list' } })}
                  onTabChange={setTab}
                />
              ) : null}

              {state.view.type !== 'settings' && state.mode === 'digital_human' ? <DigitalHumanPage /> : null}
              {state.view.type !== 'settings' && state.mode === 'image' ? <ImageGenPage /> : null}
              {state.view.type !== 'settings' && state.mode === 'video' ? <VideoGenPage /> : null}
              {state.view.type !== 'settings' && state.mode === 'music' ? <MusicGenPage /> : null}
              {state.view.type !== 'settings' && state.mode === 'tts' ? <VoiceDesignPage /> : null}
            </div>
          </div>
        </main>

        <footer className="mx-auto w-full max-w-[1360px] px-5 pb-6 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-4 text-[11px] text-[var(--fg-4)]">
            {publicMode ? (
              <>
                <span>托管服务 · 数据由服务端统一保存</span>
                <span>无限创作 Studio</span>
              </>
            ) : (
              <>
                <span className="flex flex-wrap items-center gap-2">
                  无限创作 Studio · 小说到成片的一站式 AI 创作平台
                  <a
                    href="https://github.com/SwotAtmk/infinite-creation"
                    target="_blank"
                    rel="noreferrer"
                    aria-label="GitHub"
                    className="flex items-center gap-1.5 text-[var(--fg-4)] no-underline transition-colors hover:text-[var(--fg)]"
                    style={{ marginLeft: 10, fontSize: 13 }}
                    title="SwotAtmk/infinite-creation"
                  >
                    <Github size={18} />
                    <span>SwotAtmk/infinite-creation</span>
                  </a>
                </span>
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
