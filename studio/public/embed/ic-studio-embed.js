/**
 * IC Studio 宿主嵌入 SDK（独立文件，方便在任意项目里复用）
 *
 * 用法（普通 <script>）：
 *   <script src="http://127.0.0.1:4710/embed/ic-studio-embed.js"></script>
 *   const studio = ICStudio.create({
 *     target: '#stage',            // 或 mount: element
 *     baseUrl: 'http://127.0.0.1:4710/',
 *     session: '<session-token>',  // 可选：宿主登录态
 *     view: 'list',                // list | project | settings
 *     onReady(api) {},
 *     onView({ view, id, tab }) {},
 *   });
 *   studio.navigate('project', { id: '<projectId>', tab: 'chapters' });
 *   studio.setSession('<new-token>');
 *   studio.destroy();
 *
 * 协议：
 *   宿主 -> Studio：{ type:'studio:navigate', view, id, tab } / { type:'studio:session', token }
 *   Studio -> 宿主：{ type:'studio:ready', version, hasSession } / { type:'studio:view', view, id, tab }
 *
 * 安全：只接受来自 Studio origin 且 source 匹配的消息；会话只做透传，服务端仍需校验。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ICStudio = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;

  function resolveBase(baseUrl) {
    if (baseUrl) return new URL(baseUrl, window.location.href);
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].src || '';
      if (src.indexOf('ic-studio-embed') !== -1) return new URL('.', src);
    }
    return new URL('/', window.location.href);
  }

  function create(options) {
    options = options || {};
    var base = resolveBase(options.baseUrl);
    var mount = options.mount || (typeof options.target === 'string' ? document.querySelector(options.target) : options.target) || document.body;

    var iframe = document.createElement('iframe');
    iframe.title = options.title || '无限创作 Studio';
    iframe.setAttribute('allow', 'autoplay; fullscreen; clipboard-write; encrypted-media');
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.width = options.width || '100%';
    iframe.style.height = options.height || '100%';
    iframe.style.background = '#0a0b0d';

    var session = String(options.session || '');
    var view = { view: options.view || 'list', id: options.id || null, tab: options.tab || null };
    var status = { ready: false, destroyed: false };
    var api;

    function buildUrl() {
      var u = new URL(base.href);
      u.searchParams.set('embed', options.embed === false ? '0' : '1');
      if (session) u.searchParams.set('session', session);
      if (view.view === 'project' && view.id) {
        u.searchParams.set('view', 'project');
        u.searchParams.set('id', view.id);
        u.searchParams.set('tab', view.tab || 'chapters');
      } else if (view.view === 'settings') {
        u.searchParams.set('view', 'settings');
      }
      return u.href;
    }

    function post(message) {
      if (status.destroyed || !iframe.contentWindow) return;
      iframe.contentWindow.postMessage(message, base.origin);
    }

    function onMessage(event) {
      if (status.destroyed) return;
      if (event.source !== iframe.contentWindow) return;
      if (event.origin !== base.origin) return;
      var data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'studio:ready') {
        status.ready = true;
        if (typeof options.onReady === 'function') options.onReady(api, data);
      } else if (data.type === 'studio:view') {
        view = { view: data.view, id: data.id || null, tab: data.tab || null };
        if (typeof options.onView === 'function') options.onView(view, api);
      }
      if (typeof options.onMessage === 'function') options.onMessage(data, api);
    }

    api = {
      iframe: iframe,
      version: VERSION,
      isReady: function () {
        return status.ready;
      },
      getView: function () {
        return { view: view.view, id: view.id, tab: view.tab };
      },
      navigate: function (nextView, opts) {
        opts = opts || {};
        view = {
          view: nextView === 'project' ? 'project' : nextView === 'settings' ? 'settings' : 'list',
          id: opts.id || (nextView === 'project' ? view.id : null),
          tab: opts.tab || (nextView === 'project' ? 'chapters' : null),
        };
        if (!status.ready) {
          iframe.src = buildUrl();
          return api;
        }
        post({ type: 'studio:navigate', view: view.view, id: view.id, tab: view.tab });
        return api;
      },
      setSession: function (token) {
        session = String(token || '');
        // Studio 收到会话变化后会整页重载；未就绪时直接重建 URL
        if (status.ready) {
          status.ready = false;
          post({ type: 'studio:session', token: session });
        } else {
          iframe.src = buildUrl();
        }
        return api;
      },
      reload: function () {
        status.ready = false;
        iframe.src = buildUrl();
        return api;
      },
      destroy: function () {
        if (status.destroyed) return;
        status.destroyed = true;
        window.removeEventListener('message', onMessage);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      },
    };

    window.addEventListener('message', onMessage);
    iframe.src = buildUrl();
    mount.appendChild(iframe);
    return api;
  }

  return { version: VERSION, create: create };
});
