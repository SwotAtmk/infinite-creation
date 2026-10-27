import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { ToastProvider } from './components/toast.jsx';
import BackToTop from './components/BackToTop.jsx';
import TopBar from './components/TopBar.jsx';
import LoginPage from './components/LoginPage.jsx';
import ProjectsPage from './pages/ProjectsPage.jsx';
import ProjectWorkspace from './pages/ProjectWorkspace.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import UsagePage from './pages/UsagePage.jsx';
import { Button } from './components/ui.jsx';
import { useServerInfo } from './lib/hooks.js';
import { initSessionFromUrl, setSessionToken, getSessionToken } from './lib/session.js';
import { authHeaders, clearAuthToken, getAuthToken, setAuthToken } from './lib/auth.js';
import { api } from './lib/api.js';
import { setAuthGateHandler, setAuthState } from './lib/auth-gate.js';

function parseView() {
  // 免登录模式下不显示「管理」按钮，统一通过独立路由 /admin 进入
  if (/^\/admin\/?$/i.test(window.location.pathname)) return { type: 'admin' };
  if (/^\/usage\/?$/i.test(window.location.pathname)) return { type: 'usage' };
  const p = new URLSearchParams(window.location.search);
  const type = p.get('view');
  if (type === 'project') {
    const id = p.get('id');
    if (id) return { type: 'project', id, tab: p.get('tab') || 'chapters' };
  }
  if (type === 'settings') return { type: 'settings' };
  if (type === 'usage') return { type: 'usage' };
  if (type === 'admin') return { type: 'admin' };
  return { type: 'list' };
}

function urlFor(view) {
  if (view.type === 'project') {
    let u = '/?view=project&id=' + encodeURIComponent(view.id);
    if (view.tab) u += '&tab=' + encodeURIComponent(view.tab);
    return u;
  }
  if (view.type === 'settings') return '/?view=settings';
  if (view.type === 'admin') return '/admin';
  if (view.type === 'usage') return '/usage';
  return '/';
}

export default function App() {
  const [view, setView] = useState({ type: 'list' });
  const [embed] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('embed') === '0') return false;
    return p.get('embed') === '1' || window.self !== window.top;
  });
  const goRef = useRef(null);
  const server = useServerInfo();
  const sessionRef = useRef('');
  const [unauthorized, setUnauthorized] = useState(false);
  const [auth, setAuth] = useState({ loading: true, authEnabled: false, hasUsers: true, user: null });
  const [features, setFeatures] = useState(null);
  const [adminAllowed, setAdminAllowed] = useState(false);
  const ssoOriginsRef = useRef([]);
  const authRef = useRef(auth);
  authRef.current = auth;
  // 按需登录：进入 Studio 不强制登录，只有点到「新建项目」等需要身份的操作才弹框。
  const [loginPrompt, setLoginPrompt] = useState({ open: false, reason: '' });
  const loginResolver = useRef(null);

  const askLogin = useCallback((reason) => {
    const a = authRef.current;
    if (!a.authEnabled || a.user) return Promise.resolve(true);
    if (loginResolver.current) return loginResolver.current.promise;
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    loginResolver.current = { promise, resolve };
    setLoginPrompt({ open: true, reason: reason || '' });
    return promise;
  }, []);

  const finishLogin = useCallback((user) => {
    const pending = loginResolver.current;
    loginResolver.current = null;
    setLoginPrompt({ open: false, reason: '' });
    if (user) {
      authRef.current = { ...authRef.current, user, hasUsers: true, loading: false };
      setAuth((a) => ({ ...a, user, hasUsers: true, loading: false }));
      pending?.resolve(true);
    } else {
      pending?.resolve(false);
    }
  }, []);

  // 把弹框能力交给 api.js 与其他模块（写操作 401 -> 弹登录 -> 自动重放请求）
  useEffect(() => {
    setAuthGateHandler(askLogin);
    return () => setAuthGateHandler(null);
  }, [askLogin]);

  useEffect(() => {
    setAuthState({ authEnabled: auth.authEnabled, user: auth.user });
  }, [auth.authEnabled, auth.user]);

  useEffect(() => {
    sessionRef.current = initSessionFromUrl();

    // 读取登录态：IC_AUTH=1 时返回当前用户，否则返回本地管理员。
    // 嵌入模式：URL 上带 ?jwt= 时先用它换本地会话，换完立即从地址栏移除（避免被转发/留在历史里）。
    let alive = true;
    const loadMe = () =>
      fetch('/api/auth/me', { headers: authHeaders() })
        .then((r) => r.json())
        .then((j) => {
          if (!alive) return;
          setFeatures(j.features || {});
          setAdminAllowed(!!j.adminAllowed);
          ssoOriginsRef.current = Array.isArray(j.ssoOrigins) ? j.ssoOrigins : [];
          setAuth({ loading: false, authEnabled: !!j.authEnabled, hasUsers: !!j.hasUsers, user: j.user || null });
        })
        .catch(() => {
          if (alive) setAuth({ loading: false, authEnabled: false, hasUsers: true, user: { id: 'local', username: 'local', role: 'admin' } });
        });
    (async () => {
      const p = new URLSearchParams(window.location.search);
      const jwt = p.get('jwt') || p.get('ic_jwt');
      if (jwt && !getAuthToken()) {
        try {
          const r = await api.post('/api/auth/sso', { jwt });
          if (r?.token) setAuthToken(r.token);
        } catch {
          /* SSO 失败时回落到访客态（详情由后续登录提示承担） */
        }
        p.delete('jwt');
        p.delete('ic_jwt');
        const qs = p.toString();
        window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
      }
      loadMe();
    })();

    const sync = () => setView(parseView());
    sync();
    window.addEventListener('popstate', sync);

    const onMessage = (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      // 父页面来源白名单：配置了 allowedOrigins 时，只接受同源或名单内的消息
      const allowed = ssoOriginsRef.current;
      if (allowed.length && e.origin !== window.location.origin && !allowed.includes(e.origin)) return;
      if (d.type === 'studio:navigate') {
        if (d.view === 'project' && d.id) goRef.current?.({ type: 'project', id: String(d.id), tab: d.tab || 'chapters' });
        else if (d.view === 'settings') goRef.current?.({ type: 'settings' });
        else goRef.current?.({ type: 'list' });
      }
      if (d.type === 'studio:session' && d.token) {
        const token = String(d.token);
        if (token !== sessionRef.current) {
          sessionRef.current = token;
          setSessionToken(token);
          window.location.reload();
        }
      }
      if (d.type === 'studio:sso' && d.jwt) {
        api
          .post('/api/auth/sso', { jwt: String(d.jwt) })
          .then((r) => {
            if (r?.token) {
              setAuthToken(r.token);
              window.location.reload();
            }
          })
          .catch(() => {});
      }
    };
    window.addEventListener('message', onMessage);

    const onUnauthorized = () => {
      if (authRef.current.authEnabled) {
        clearAuthToken();
        setAuth((a) => ({ ...a, user: null, loading: false }));
      } else {
        setUnauthorized(true);
      }
    };
    window.addEventListener('ic-studio:unauthorized', onUnauthorized);

    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'studio:ready', version: 1, hasSession: !!getSessionToken() }, '*');
    }

    return () => {
      alive = false;
      window.removeEventListener('popstate', sync);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('ic-studio:unauthorized', onUnauthorized);
    };
  }, []);

  useEffect(() => {
    document.title = view.type === 'project' ? '项目 · 无限创作 Studio' : view.type === 'settings' ? '设置 · 无限创作 Studio' : view.type === 'usage' ? '消费记录 · 无限创作 Studio' : '无限创作 Studio';
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'studio:view', view: view.type, id: view.id || null, tab: view.tab || null }, '*');
    }
  }, [view]);

  const go = (v) => {
    window.history.pushState(null, '', urlFor(v));
    setView(v);
  };
  goRef.current = go;

  const setTab = (tab) => {
    setView((v) => {
      const nv = { ...v, tab };
      window.history.replaceState(null, '', urlFor(nv));
      return nv;
    });
  };

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
    } catch {
      /* 忽略 */
    }
    clearAuthToken();
    setAuth((a) => ({ ...a, user: null }));
    // 整页回到首页：重新拉 /api/auth/me，确保管理后台权限（adminAllowed）也被清除
    window.location.assign('/');
  }

  const wide = view.type === 'project';
  const canAdmin = !auth.authEnabled || auth.user?.role === 'admin';
  // 未登录的访客：仍可进入列表页浏览框架，但数据与写操作需要登录
  const guest = auth.authEnabled && !auth.user;

  if (auth.loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="skeleton h-24 w-64 rounded-2xl" />
      </div>
    );
  }

  return (
    <ToastProvider>
      <div className="relative z-[1] flex min-h-screen flex-col" data-embed={embed ? 'true' : 'false'}>
        {!embed ? (
          <TopBar
            view={view}
            onHome={() => go({ type: 'list' })}
            onSettings={() => go({ type: 'settings' })}
            serverInfo={server}
            auth={auth}
            features={features || {}}
            adminAllowed={adminAllowed}
            canAdmin={canAdmin}
            showSettings={!features || features.settings !== false}
            onLogout={logout}
            onLogin={askLogin}
            onAdmin={() => go({ type: 'admin' })}
          />
        ) : null}
        <main className={embed ? 'w-full flex-1 px-3 py-3' : wide ? 'mx-auto w-full max-w-[1360px] flex-1 px-5 py-6' : 'mx-auto w-full max-w-[1200px] flex-1 px-5 py-8'}>
          {unauthorized ? (
            <SessionRequired embed={embed} hasSession={!!getSessionToken()} />
          ) : (
            <>
              {view.type === 'list' ? (
                <ProjectsPage
                  publicMode={server.publicMode}
                  guest={guest}
                  auth={auth}
                  features={features || {}}
                  onOpen={(id) => go({ type: 'project', id, tab: 'chapters' })}
                />
              ) : null}
              {view.type === 'project' ? (
                <ProjectWorkspace
                  key={view.id}
                  id={view.id}
                  guest={guest}
                  auth={auth}
                  features={features || {}}
                  initialTab={view.tab}
                  onBack={() => go({ type: 'list' })}
                  onTabChange={setTab}
                />
              ) : null}
              {view.type === 'admin' ? (
                !adminAllowed ? (
                  auth.user && !canAdmin ? (
                    <div className="panel mx-auto flex max-w-[520px] flex-col items-center gap-3 px-6 py-12 text-center">
                      <Lock size={20} className="text-[var(--fg-3)]" />
                      <p className="m-0 text-[13px] text-[var(--fg-2)]">需要管理员权限</p>
                      <Button variant="secondary" size="md" onClick={() => go({ type: 'list' })}>
                        返回
                      </Button>
                    </div>
                  ) : (
                    <LoginPage
                      hasUsers={auth.hasUsers}
                      title="管理员登录"
                      description="管理后台需要管理员账号登录（免登录模式也一样）。"
                      onAuthed={() => window.location.reload()}
                    />
                  )
                ) : (
                  <AdminPage onBack={() => go({ type: 'list' })} />
                )
              ) : null}
              {view.type === 'usage' ? (
                guest ? (
                  <LoginPage
                    hasUsers={auth.hasUsers}
                    title="登录查看消费记录"
                    description="登录后可查看自己的积分余额、每一步消耗和任务状态。"
                    onAuthed={() => window.location.reload()}
                  />
                ) : (
                  <UsagePage onBack={() => go({ type: 'list' })} />
                )
              ) : null}
              {view.type === 'settings' ? (
                !adminAllowed ? (
                  auth.user && !canAdmin ? (
                    <div className="panel mx-auto flex max-w-[520px] flex-col items-center gap-3 px-6 py-12 text-center">
                      <Lock size={20} className="text-[var(--fg-3)]" />
                      <p className="m-0 text-[13px] text-[var(--fg-2)]">需要管理员权限</p>
                      <Button variant="secondary" size="md" onClick={() => go({ type: 'list' })}>
                        返回
                      </Button>
                    </div>
                  ) : (
                    <LoginPage
                      hasUsers={auth.hasUsers}
                      title="管理员登录"
                      description="设置页需要管理员账号登录（免登录模式也一样）。"
                      onAuthed={() => window.location.reload()}
                    />
                  )
                ) : (
                  <SettingsPage onBack={() => go({ type: 'list' })} publicMode={server.publicMode} />
                )
              ) : null}
            </>
          )}
        </main>
        {!embed ? (
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
        ) : null}
        {!embed ? <BackToTop /> : null}
        {loginPrompt.open ? (
          <LoginPage
            dialog
            hasUsers={auth.hasUsers}
            reason={loginPrompt.reason}
            onAuthed={finishLogin}
            onClose={() => finishLogin(null)}
          />
        ) : null}
      </div>
    </ToastProvider>
  );
}

function SessionRequired({ embed, hasSession }) {
  return (
    <div className={embed ? 'flex min-h-[60vh] items-center justify-center px-3' : 'mx-auto flex w-full max-w-[560px] items-center justify-center py-16'}>
      <div className="panel flex w-full flex-col items-center gap-4 px-8 py-10 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--line)] bg-white/[0.03] text-[var(--accent)]">
          <Lock size={20} />
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[18px] font-semibold tracking-[-.01em] text-[var(--fg)]">需要宿主会话</h1>
          <p className="m-0 text-[12px] leading-relaxed text-[var(--fg-3)]">
            {hasSession ? '当前会话无效或已过期。' : '该服务要求通过 iframe / URL 传入会话标识。'}
          </p>
          <p className="m-0 max-w-[420px] text-[11.5px] leading-relaxed text-[var(--fg-4)]">
            宿主项目请使用 <code className="font-mono text-[var(--fg-3)]">ICStudio.create()</code> 创建 iframe，或在地址栏带
            <code className="mx-1 font-mono text-[var(--fg-3)]">?session=&lt;token&gt;</code>。
          </p>
        </div>
        <Button variant="primary" size="md" onClick={() => window.location.reload()}>
          重新加载
        </Button>
      </div>
    </div>
  );
}
