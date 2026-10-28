# Docker 部署

一个 `docker-compose.yml` 同时支持 PostgreSQL 和 SQLite，用 `.env` 切换，不需要两份 compose 文件。

镜像里包含：后端 API、Agent、Studio 页面、ffmpeg/ffprobe。
镜像里不包含：ComfyUI、LLM、RunningHub 或任何模型文件；这些都在 `config.json` 里配置外部地址和密钥。

## 1. 准备文件

```bash
cp .env.docker.example .env
cp config.example.json config.json
```

然后编辑：

- `.env`：至少修改 `POSTGRES_PASSWORD`（PostgreSQL 模式）
- `config.json`：填入 RunningHub、LLM 等真实配置；这个文件不要提交到仓库

`config.json` 会挂载到容器里的 `/data/config.json`，修改后重启 app 生效。

## 2. 选择数据库

### PostgreSQL（默认，推荐）

`.env` 保持：

```dotenv
DB_MODE=postgres
COMPOSE_PROFILES=postgres
POSTGRES_DB=infinite_creation
POSTGRES_USER=ic
POSTGRES_PASSWORD=换成你的密码
```

启动：

```bash
docker compose up -d --build
```

会启动：

- `db`：PostgreSQL 16，数据在 Docker volume `pgdata`
- `app`：后端 + Agent，端口 4610（只在容器网络内）
- `web`：唯一的 Web 入口，端口 4710（对外）

打开：<http://localhost:4710>

`WEB_MODE` 决定这个 Web 入口显示哪个页面，只启动一个进程：

```dotenv
WEB_MODE=studio    # Studio 页面（默认）
WEB_MODE=classic   # 经典 Next 页面
```

### SQLite（单机 / 试用）

把 `.env` 改成：

```dotenv
DB_MODE=sqlite
COMPOSE_PROFILES=
POSTGRES_PASSWORD=
```

启动：

```bash
docker compose up -d --build
```

此时只启动 `app` 和 `web`，不启动 `db`。

数据文件：

- 数据库：`./data/ic.db`
- 媒体：`./data/projects/<项目ID>/`

> Windows 上 SQLite 放在 bind mount 里并发写入性能一般；多人使用请用 PostgreSQL。

## 3. 数据目录

容器内统一使用：

```text
/data/ic.db               SQLite 数据库（SQLite 模式）
/data/projects/<项目ID>/   图片、视频、音频、成片、项目日志
/data/config.json         配置
```

宿主机对应 `./data` 和 `./config.json`。

数据库里存的是项目内相对路径，所以只要把 `data/projects` 挂载到 `/data/projects`，历史媒体文件就能继续访问。

## 4. 迁移现有数据库

迁移脚本：`scripts/docker-migrate.mjs`。媒体文件不经过数据库，迁移后继续使用 `data/projects`。

### 本地 SQLite → Docker PostgreSQL

```bash
node scripts/docker-migrate.mjs --from sqlite --to postgres
```

它会启动 compose 里的 `db`，用 app 镜像运行 `db-migrate.mjs`，把 `data/ic.db` 写入 Docker PostgreSQL。

### 本机现有 PostgreSQL → Docker PostgreSQL

```bash
node scripts/docker-migrate.mjs --from postgres --to postgres \
  --from-url 'postgres://ic:密码@host.docker.internal:55432/infinite_creation'
```

`host.docker.internal` 用来从容器访问宿主机上的 PostgreSQL；compose 已经给 app 配了 `extra_hosts`。

### Docker PostgreSQL → 宿主机 SQLite（给 SQLite 模式用）

```bash
node scripts/docker-migrate.mjs --from postgres --to sqlite --replace
```

目标默认是 `data/ic.db`。执行前脚本会自动备份旧 SQLite。

### 本地 SQLite → 另一个 SQLite

```bash
node scripts/docker-migrate.mjs --from sqlite --to sqlite \
  --sqlite data/old.db
```

默认目标是 `data/ic.db`；如果源和目标相同会拒绝执行。

### 常用参数

```text
--replace       清空目标表后重写（默认按主键 upsert）
--no-build      不重新构建 app 镜像
--dry-run       只打印命令
--sqlite PATH   指定宿主机 SQLite 文件
--from-url URL  源 PostgreSQL 连接串
--to-url URL    目标 PostgreSQL 连接串
--compose FILE  指定 compose 文件
```

迁移完成后：

```bash
docker compose up -d
```

## 5. 从 PostgreSQL 切到 SQLite

1. 先迁移数据库：

   ```bash
   node scripts/docker-migrate.mjs --from postgres --to sqlite --replace
   ```

2. 修改 `.env`：

   ```dotenv
   DB_MODE=sqlite
   COMPOSE_PROFILES=
   ```

3. 重启：

   ```bash
   docker compose down
   docker compose up -d
   ```

`data/projects` 不需要动。`pgdata` volume 会保留，但 SQLite 模式不使用它。

## 6. 查看状态

```bash
docker compose ps
docker compose logs -f app
docker compose logs -f web
```

健康检查：

```bash
curl http://localhost:4710/api/health
```

Web 入口由 app 镜像内的轻量服务器（`scripts/serve-web.mjs`）提供：`WEB_MODE=studio` 时托管 Studio 静态文件并代理 `/api`、`/files`、`/ws`；`WEB_MODE=classic` 时把全部请求反代到后端经典页面。不包含 ComfyUI、LLM、RunningHub 等模型/推理服务，这些都在 `config.json` 里配置外部地址。
