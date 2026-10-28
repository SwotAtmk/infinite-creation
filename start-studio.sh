#!/usr/bin/env bash
set -u

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1

export BACKEND_PORT=4610
export PORT=4610
export STUDIO_PORT=4710
LOG_DIR="$(pwd)/studio/logs"
STUDIO_LOG="$(pwd)/studio/logs/studio.log"
STUDIO_ERR_LOG="$(pwd)/studio/logs/studio.err.log"
BACKEND_LOG="$(pwd)/logs/studio-backend.log"
BACKEND_ERR_LOG="$(pwd)/logs/studio-backend.err.log"
NEXT_DIST_DIR=".next-studio-dev"

# 长任务（Agent + 多候选渲染）内存峰值较高，避免默认 4GB 堆直接 OOM
export NODE_OPTIONS="--max-old-space-size=8192"
# 开发模式用独立 dist，避免 Next dev 覆盖 start-studio-prod 的 .next-studio 生产构建
export HOST="0.0.0.0"
export IC_AUTH=1
export IC_MODERATION=1
export IC_MODERATION_FAIL_CLOSED=1

# Arguments:
#   public  - public hosting (IC_PUBLIC=1, secrets hidden, config read-only)
#   secure  - public hosting + forced session check (IC_PUBLIC=1 + IC_SESSION_REQUIRE=1)
case "${1:-}" in
  public)
    export IC_PUBLIC=1
    ;;
  secure)
    export IC_PUBLIC=1
    export IC_SESSION_REQUIRE=1
    ;;
esac

port_in_use() {
  lsof -i "tcp:${1}" -sTCP:LISTEN -n -P >/dev/null 2>&1
}

wait_for_port() {
  local port="$1"
  local timeout="$2"
  local name="$3"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if port_in_use "$port"; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "  [错误] ${name} 端口 ${port} 在 ${timeout} 秒内未就绪" >&2
  return 1
}

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "本机内网IP")"

echo "============================================"
echo "  infinite-creation Studio 启动"
echo "============================================"
echo "  public = 对外托管；secure = 托管 + 强制会话"
echo ""

# 依赖检查
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 node，请先安装 Node.js 22 或更高版本"
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[错误] 未找到 pnpm，请先执行：npm i -g pnpm"
  exit 1
fi

# 依赖安装检查
if [ ! -f "node_modules/next/package.json" ] || [ ! -f "studio/node_modules/vite/package.json" ]; then
  echo "[检查] 依赖未安装，执行 pnpm install ..."
  pnpm install --config.confirmModulesPurge=false || {
    echo "[错误] pnpm install 失败"
    exit 1
  }
fi

# 日志目录
mkdir -p "$LOG_DIR" "$(pwd)/logs"

# Studio uses its own backend on 4610 and its own build dir .next-studio,
# isolated from the classic UI backend on 4600 (no .next overwrite).
if ! port_in_use "$BACKEND_PORT"; then
  echo "[启动] Studio 后端 ${BACKEND_PORT} ..."
  nohup node server.js > "$BACKEND_LOG" 2> "$BACKEND_ERR_LOG" &
  wait_for_port "$BACKEND_PORT" 120 "Studio 后端" || {
    echo "[错误] Studio 后端 120 秒内未就绪，请查看 logs/studio-backend.log"
    exit 1
  }
fi

if ! port_in_use "$STUDIO_PORT"; then
  echo "[启动] Studio 前端 ${STUDIO_PORT} ..."
  nohup pnpm --filter studio dev > "$STUDIO_LOG" 2> "$STUDIO_ERR_LOG" &
  wait_for_port "$STUDIO_PORT" 90 "Studio 前端" || {
    echo "[错误] Studio 前端 90 秒内未就绪，请查看 studio/logs/studio.log"
    exit 1
  }
fi

echo ""
echo "  Studio"
echo "  http://127.0.0.1:${STUDIO_PORT}"
echo "  局域网：http://${LAN_IP}:${STUDIO_PORT}"
echo ""
echo "  Studio 后端"
echo "  http://127.0.0.1:${BACKEND_PORT}"
echo "  局域网：http://${LAN_IP}:${BACKEND_PORT}"
echo ""
echo "  日志"
echo "  ${BACKEND_LOG}"
echo "  ${STUDIO_LOG}"
echo ""

if [ "${IC_PUBLIC:-0}" = "1" ]; then
  echo "  [模式] 对外托管：密钥不下发，配置接口只读"
fi
if [ "${IC_SESSION_REQUIRE:-0}" = "1" ]; then
  echo "  [会话] 已强制校验：X-IC-Session 或 ?session="
  if [ -z "${IC_SESSION_SECRET:-}" ]; then
    echo "  [提示] 未设置 IC_SESSION_SECRET，令牌只做存在性校验"
  fi
fi

if port_in_use 8188; then
  echo "  [OK] ComfyUI 8188 is running"
else
  echo "  [INFO] RunningHub mode; local ComfyUI not required"
fi

echo ""
echo "关闭本窗口不会停止服务，请使用 stop-studio.sh 停止 Studio（前端 + 独立后端）。"
echo "经典界面 4600 不受影响，停止它请使用 stop-infinite-creation.sh。"
exit 0
