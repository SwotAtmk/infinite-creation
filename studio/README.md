# 无限创作 Studio

独立启动的新界面（Vite + React + Tailwind + Radix），与经典 Next 界面**共用同一套后端、数据库与任务队列**，但拥有独立的启动方式、端口与视觉系统。

- Studio：<http://127.0.0.1:4710>
- 后端：<http://127.0.0.1:4610>
- 经典界面：<http://127.0.0.1:4600>
- 数据目录：仓库根目录的 `data/`（与经典界面完全相同）

## 启动

在仓库根目录：

```bash
# 前台启动（日志实时输出，Ctrl+C 同时停止前后端）
pnpm run dev

# 后台启动（日志写入文件）
pnpm run dev:background
./start-studio.sh   # 等价脚本（macOS / Linux）
./stop-studio.sh    # 停止 Studio

# Windows
start-studio.bat
stop-studio.bat
```

开发时也可以手动启动：

```bash
# 终端 1：后端（Studio 独立实例，4610）
PORT=4610 NEXT_DIST_DIR=.next-studio-dev pnpm run dev:classic

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

## 账号与权限

开源版不包含账号、登录、管理后台、积分计费、内容审核与 iframe 嵌入：Studio 与经典界面一样直接开放，只应部署在可信网络内。

## 架构

Studio 本身**不带后端**，Vite dev server 把以下请求代理到后端：

| 路径 | 用途 |
| --- | --- |
| `/api/*` | 所有业务接口（项目、章节、素材、分镜、任务、配置、技能） |
| `/ws` | WebSocket 实时进度与任务通知 |
| `/files/*` | 成片、素材、海报等静态文件 |

因此两套界面看到的是同一份数据；同时只会有一个后端进程读写 SQLite，不会出现双实例抢库的问题。

代理目标可通过环境变量覆盖：

```bash
STUDIO_BACKEND=http://127.0.0.1:4610 STUDIO_PORT=4710 pnpm --filter studio dev
```

## 对外部署清单

1. **配置 LLM**：`config.json` 的 `llm.baseUrl`、`llm.model`、`llm.apiKey` 必须是服务端可用的模型；否则分镜与提示词阶段无法运行。
2. **反向代理**：把 Studio 的 `/api`、`/ws`、`/files` 代理到后端；WebSocket 需要 Upgrade 支持。
3. **HTTPS**：公网访问请使用 https，WS 会走 `wss://`。
4. **限流与配额**：生成任务会消耗 RunningHub 额度，建议在网关层限流。
5. **访问控制**：开源版没有登录与账号隔离，只应部署在可信网络内；公网部署请在反向代理层自行加认证。

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
  vite.config.js  端口 4710 与后端代理
```

## 构建

```bash
pnpm --filter studio build   # 产物：studio/dist
```

`dist/` 是纯静态文件，可由任意静态服务器托管；但 `/api`、`/ws`、`/files` 必须反向代理到后端（参考 `vite.config.js` 的 proxy 配置）。
