#!/usr/bin/env bash
set -u

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1

export BACKEND_PORT=4610
export STUDIO_PORT=4710
export NEXT_DIST_DIR=".next-studio"
# 长任务（Agent + 多候选渲染）内存峰值较高，避免默认 4GB 堆直接 OOM
export NODE_OPTIONS="--max-old-space-size=8192"
export HOST="0.0.0.0"
export IC_AUTH=1
export IC_MODERATION=1
export IC_MODERATION_FAIL_CLOSED=1
export STUDIO_BACKEND="http://127.0.0.1:4610"
LOG_DIR="$(pwd)/studio/logs"
BACKEND_LOG="$(pwd)/logs/studio-backend.log"
BACKEND_ERR_LOG="$(pwd)/logs/studio-backend.err.log"
STUDIO_LOG="$(pwd)/studio/logs/studio-preview.log"
STUDIO_ERR_LOG="$(pwd)/studio/logs/studio-preview.err.log"

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

mkdir -p "$LOG_DIR" "$(pwd)/logs"

echo "============================================"
echo "  infinite-creation Studio 生产模式"
echo "============================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 node，请先安装 Node.js 22 或更高版本"
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[错误] 未找到 pnpm，请先执行：npm i -g pnpm"
  exit 1
fi

echo "[1/4] 构建 Studio 前端..."
pnpm --filter studio build || {
  echo "[错误] 构建失败，请查看上方输出"
  exit 1
}

echo "[2/4] 构建 Next 后端（生产）..."
pnpm build || {
  echo "[错误] 构建失败，请查看上方输出"
  exit 1
}

export NODE_ENV=production
export PORT="$BACKEND_PORT"

echo "[3/4] 启动后端 ${BACKEND_PORT}（生产模式）..."
if ! port_in_use "$BACKEND_PORT"; then
  nohup node server.js > "$BACKEND_LOG" 2> "$BACKEND_ERR_LOG" &
  wait_for_port "$BACKEND_PORT" 120 "后端" || {
    echo "[错误] 后端 120 秒内未启动，请查看 logs/studio-backend.log"
    exit 1
  }
fi

echo "[4/4] 启动 Studio 静态预览 ${STUDIO_PORT}..."
if ! port_in_use "$STUDIO_PORT"; then
  nohup pnpm --filter studio preview > "$STUDIO_LOG" 2> "$STUDIO_ERR_LOG" &
  wait_for_port "$STUDIO_PORT" 60 "Studio" || {
    echo "[错误] Studio 60 秒内未启动，请查看 studio/logs/studio-preview.log"
    exit 1
  }
fi

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "本机内网IP")"

echo ""
echo "  Studio（生产模式）"
echo "  http://127.0.0.1:${STUDIO_PORT}"
echo "  局域网：http://${LAN_IP}:${STUDIO_PORT}"
echo ""
echo "  后端"
echo "  http://127.0.0.1:${BACKEND_PORT}"
echo "  局域网：http://${LAN_IP}:${BACKEND_PORT}"
echo ""
echo "  日志"
echo "  ${BACKEND_LOG}"
echo "  ${STUDIO_LOG}"
echo ""
echo "停止服务请运行 stop-studio.sh"
exit 0
