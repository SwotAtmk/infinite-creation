# 无限创作 Studio

独立启动的新界面（Vite + React + Tailwind + Radix），与经典 Next 界面**共用同一套后端、数据库与任务队列**，但拥有独立的启动方式、端口与视觉系统。

- Studio：<http://127.0.0.1:4710>
- 后端 / 经典界面：<http://127.0.0.1:4600>
- 数据目录：仓库根目录的 `data/`（与经典界面完全相同）

## 启动

在仓库根目录：

```bash
# 一键启动（Windows，自动拉起后端 + Studio）
start-studio.bat

# 对外托管模式：后端以 IC_PUBLIC=1 启动（密钥不下发、配置接口只读）
start-studio.bat public

# 停止 Studio（后端保持运行）
stop-studio.bat
```

开发时也可以手动启动：

```bash
# 终端 1：后端
pnpm run dev

# 终端 1（对外托管）：密钥不下发
IC_PUBLIC=1 pnpm run dev

# 终端 2：Studio
pnpm --filter studio dev
```

首次安装依赖只需在仓库根目录执行一次 `pnpm install`。

### 云端生成（RunningHub）

对外服务默认走 RunningHub，不需要本地 ComfyUI。配置保存在服务端 `config.json`：

```json
{
  "comfyui": { "provider": "runninghub", "apiKey": "<server-side-key>", "tier": "standard" }
}
```

`IC_PUBLIC=1` 时 `/api/config` 不会下发 `apiKey`，`PUT /api/config` 直接返回 403。密钥只存在于服务端进程内。

> LLM 仍然需要一个 OpenAI 兼容的模型服务（`config.llm.baseUrl` / `apiKey` / `model`），它负责写剧本、分镜与提示词；RunningHub 只负责出图/出片。

## 账号与登录

`start-studio.bat` 默认设置 `IC_AUTH=1`：

- 首次打开 <http://127.0.0.1:4710> 会要求创建**管理员账号**（用户名 + 至少 8 位密码）。
- 登录后管理员可在「设置 → 账号管理」创建普通用户/管理员、重置密码、停用账号。
- **每个账号只能看到自己的项目**，管理员可以查看全部；旧项目在首个管理员创建时自动归到该管理员名下。
- 登录令牌有效期 7 天：API 走 `Authorization: Bearer`，图片/视频/WS 走 `?token=`；退出登录立即失效。
- 服务端强制归属校验：`/api/projects/:id/*` 与 `/files/projects/:id/*` 都会校验 `owner_id`；WebSocket 只推送自己项目的消息。
- 不设置 `IC_AUTH` 时为本地模式：无需登录，视为本地管理员（经典界面 4600 不受影响）。

账号与会话表：`data/ic.db` 的 `users` / `auth_sessions`。密码使用 scrypt 加盐哈希，令牌只存 SHA-256 哈希。

## 内容安全审核

`start-studio.bat` 默认设置 `IC_MODERATION=1`、`IC_MODERATION_FAIL_CLOSED=1`。审核类别：

| 类别 | 说明 |
| --- | --- |
| sexual | 露骨色情、性行为、裸露、未成年人性化 |
| violence | 血腥肢解、虐待、详细暴力伤害、自杀/自残方法 |
| political | 现实政治敏感人物/事件、分裂、颠覆、政治煽动 |
| military | 武器/爆炸物制造教学、恐怖袭击、战争罪行、军事政变 |
| religious | 宗教宣扬/传教、亵渎、宗教仇恨、邪教 |

三层拦截：

1. **写库层（同步硬规则）**：项目、章节、素材、分镜、音乐的创建/更新，包括 Agent 自动写入，命中明确违规词直接抛 `CONTENT_BLOCKED`。
2. **HTTP 写入（Next middleware）**：所有项目相关 JSON 写入先调用 `/api/moderation/check`（本地规则 + LLM 语境审核），违规返回 **422**，不进入业务路由。
3. **生成提交（workflow-runner）**：文生图/图生图/视频/音色/音乐提交前再审核一次，提示词、台词、歌词、音色描述都覆盖。

- 硬规则维护文件：`lib/core/moderation-rules.js`（可直接增删）；`IC_MODERATION_EXTRA` 可追加自定义词（逗号分隔）。
- LLM 审核使用 `config.llm`：虚构/历史背景下的战争、门派、信仰等语境内容会放行；露骨、宣扬、教学、现实政治敏感会拦截。
- LLM 审核不可用时按 `IC_MODERATION_FAIL_CLOSED=1` 拒绝写入/生成，避免绕过。
- 前端在项目、章节、音乐表单有内容规范提示；被拦截时显示具体类别与原因。

## 会话接入

宿主可以在 iframe URL 上带会话标识：

```
http://127.0.0.1:4710/?embed=1&session=<token>
```

或在加载完成后通过 postMessage 下发：

```js
iframe.contentWindow.postMessage({ type: 'studio:session', token: '<token>' }, '*');
```

Studio 会：

- 把会话标识附加到所有 `/api/*` 请求的 `X-IC-Session` 头；
- 在 WebSocket 地址上追加 `?session=<token>`，静态资源 URL 追加 `?session=`；
- 会话变化时整页重载，避免残留上一个会话的数据；
- 服务端返回 401 时显示「需要宿主会话」界面，而不是一个空项目列表。

### 宿主 SDK（推荐）

`studio/public/embed/ic-studio-embed.js` 是独立的宿主编排 SDK（无框架依赖，含 `.d.ts`）：

```html
<div id="stage" style="height: calc(100vh - 57px)"></div>
<script src="http://127.0.0.1:4710/embed/ic-studio-embed.js"></script>
<script>
  const studio = ICStudio.create({
    target: '#stage',
    baseUrl: 'http://127.0.0.1:4710/',
    session: hostSessionToken,
    view: 'list',
    onReady(api) {},
    onView(view) {},
  });

  studio.navigate('project', { id: projectId, tab: 'shots' });
  studio.setSession(nextToken);
  studio.destroy();
</script>
```

SDK 负责拼 iframe URL、校验消息来源、`studio:ready` / `studio:view` 回调、会话切换与销毁。完整示例见 <http://127.0.0.1:4710/embed-demo.html>。

### 服务端强制校验（secure 模式）

```bash
# 1. 设置签名密钥（服务端与宿主共享，不要写进前端）
set IC_SESSION_SECRET=<random-secret>

# 2. 以 secure 模式启动：IC_PUBLIC=1 + IC_SESSION_REQUIRE=1
start-studio.bat secure

# 3. 为宿主用户签发令牌
pnpm run session:token -- user-123 24
```

- 未带会话的 `/api`、`/files`、`/ws` 请求返回 401；`/api/health` 保持开放用于探活。
- 设置 `IC_SESSION_SECRET` 后令牌带 HMAC-SHA256 签名与过期时间，伪造/过期均拒绝；未设置时只做「存在性」校验。
- 会话解析、签发与校验集中在 `lib/core/session.js`，与路由解耦，便于替换成 JWT / 网关校验。

**安全边界**：会话模块目前解决的是「接入与准入」，**还没有做按会话的数据隔离**——所有会话仍然看到同一批项目。真正对外多租户时，需要给 `projects` 增加会话归属并在查询/写入侧过滤（或每个会话独立实例/数据目录）。在此之前，请把服务放在受信网关后，或仅对已授权宿主开放。

## 架构

Studio 本身**不带后端**，Vite dev server 把以下请求代理到 4600：

| 路径 | 用途 |
| --- | --- |
| `/api/*` | 所有业务接口（项目、章节、素材、分镜、任务、配置、技能） |
| `/ws` | WebSocket 实时进度与任务通知 |
| `/files/*` | 成片、素材、海报等静态文件 |

因此两套界面看到的是同一份数据；同时只会有一个后端进程读写 SQLite，不会出现双实例抢库的问题。

代理目标可通过环境变量覆盖：

```bash
STUDIO_BACKEND=http://127.0.0.1:4600 STUDIO_PORT=4710 pnpm --filter studio dev
```

## iframe 嵌入

Studio 支持作为 iframe 嵌入到宿主页面：

```html
<iframe
  src="http://127.0.0.1:4710/?embed=1"
  style="width:100%;height:100%;border:0"
  allow="autoplay; fullscreen; clipboard-write"
></iframe>
```

- `?embed=1`：隐藏顶栏与页脚，使用更紧凑的布局；不传时，在 iframe 中会自动检测并进入嵌入模式。
- `?embed=0`：即使处于 iframe 中也强制显示完整界面。
- 也可以直接在 URL 上带视图：`?embed=1&view=project&id=<项目ID>&tab=shots`。
- 对外托管模式（后端 `IC_PUBLIC=1`）下，顶栏不显示“设置 / GitHub”，设置页只展示只读服务信息。

### postMessage 协议

宿主 → Studio：

```js
iframe.contentWindow.postMessage({ type: 'studio:navigate', view: 'list' }, '*');
iframe.contentWindow.postMessage({ type: 'studio:navigate', view: 'settings' }, '*');
iframe.contentWindow.postMessage(
  { type: 'studio:navigate', view: 'project', id: '<项目ID>', tab: 'chapters' },
  '*',
);
```

`tab` 可取：`chapters`、`assets`、`shots`、`music`、`exports`、`logs`。

Studio → 宿主：

```js
window.addEventListener('message', (e) => {
  if (e.data?.type === 'studio:ready') {
    // iframe 已加载完成
  }
  if (e.data?.type === 'studio:view') {
    // { view, id, tab } —— 当前视图变化
  }
});
```

可打开 <http://127.0.0.1:4710/embed-demo.html> 查看完整可交互示例。

### 跨域与安全

- 生产环境若把 Studio 部署在独立域名，宿主页面与 Studio 的 postMessage 校验由宿主自行处理；当前协议对 `targetOrigin` 使用 `*`，如需收紧可自行改为固定 origin。
- 如果静态服务器默认发送 `X-Frame-Options: SAMEORIGIN` / `frame-ancestors 'self'`，需要为 Studio 放开对应宿主域名。
- Studio 自身没有任何鉴权，和经典界面一样，只应部署在可信网络内。

### 对外部署清单

1. **登录默认开启**：`start-studio.bat` 会设置 `IC_AUTH=1`；首次部署先创建管理员，再在「账号管理」为使用者建普通账号。`public` / `secure` 是在此之上再隐藏密钥 / 追加宿主会话校验。
2. **配置 LLM**：`config.json` 的 `llm.baseUrl`、`llm.model`、`llm.apiKey` 必须是服务端可用的模型；否则分镜与提示词阶段无法运行。
3. **账号隔离已实现**：每个账号只能访问自己的项目，`/api`、`/files`、WebSocket 都按 `owner_id` 过滤；管理员可看全部。宿主 `session` 透传是额外的一层，按需启用。
4. **反向代理**：把 Studio 的 `/api`、`/ws`、`/files` 代理到后端；WebSocket 需要 Upgrade 支持。
5. **iframe 响应头**：静态服务器不要发送 `X-Frame-Options: DENY`，并按需配置 CSP `frame-ancestors` 允许宿主域名。
6. **HTTPS**：宿主为 https 时，Studio 也必须 https，否则会被浏览器拦截混合内容；WS 会走 `wss://`；HTTPS 下登录 cookie 自动带 Secure。
7. **限流与配额**：生成任务会消耗 RunningHub 额度，建议在网关层按账号限流。
8. **内容审核**：保持 `IC_MODERATION=1`；按业务调整 `lib/core/moderation-rules.js`，并确保 `config.llm` 可用（审核与剧本共用同一模型）。

## 视觉与交互约定

- 深色创作台：炭黑背景 + 暖琥珀强调色，玻璃质感面板、细描边、Editorial 字号层级。
- 尺寸类信息全部图标化：
  - 宽高比用真实比例外框（`RatioIcon`），16:9 / 9:16 / 1:1 一眼可辨。
  - 分辨率用外框 + 高亮区域随档位变化（`ResolutionIcon`），360P → 4K 有直观的量级感。
  - 素材分类、任务类型、导出字幕类型、章节/分镜数量等都有对应图标。
- 表单：标签在上、辅助说明在下，错误态与聚焦态统一；长操作有全屏阻断层，避免重复提交。
- 任务：右侧抽屉实时展示执行中/排队中/已结束，支持取消与删除；WS 断线自动重连。

## 目录

```
studio/
  src/
    components/   基础组件（Button/Input/Select/Modal/Drawer…）、图标与媒体组件
    lib/          API 客户端、格式化、共享常量（直接复用 ../lib/shared）
    pages/        作品集、项目工作区、章节、素材、分镜、音乐、成片、日志、设置
  public/         iframe 嵌入示例
  vite.config.js  端口 4710 与后端代理
```

## 构建

```bash
pnpm --filter studio build   # 产物：studio/dist
```

`dist/` 是纯静态文件，可由任意静态服务器托管；但 `/api`、`/ws`、`/files` 必须反向代理到后端（参考 `vite.config.js` 的 proxy 配置）。
