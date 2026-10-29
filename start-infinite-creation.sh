#!/usr/bin/env bash
set -u

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1

export PORT=4600
LOG_DIR="$(pwd)/logs"
LOG_FILE="$(pwd)/logs/server.log"
ERR_LOG="$(pwd)/logs/server.err.log"

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

echo "============================================"
echo "  infinite-creation 启动脚本"
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

if port_in_use "$PORT"; then
  echo "[跳过] 端口 ${PORT} 已被占用，服务可能已在运行"
else
  if [ ! -f "node_modules/next/package.json" ]; then
    echo "[检查] 未检测到依赖，正在执行 pnpm install（非交互模式）..."
    echo ""
    pnpm install --config.confirmModulesPurge=false || {
      echo "[错误] pnpm install 失败"
      exit 1
    }
    echo ""
  fi

  mkdir -p "$LOG_DIR"
  echo "[启动] 正在后台启动 ..."
  nohup bash -c 'printf "y\n" | pnpm run dev:classic' > "$LOG_FILE" 2> "$ERR_LOG" &
  echo "[等待] 等待服务就绪 ..."
  wait_for_port "$PORT" 120 "服务" || {
    echo "[错误] 等待超时 120 秒，请查看日志：${LOG_FILE}"
    exit 1
  }
fi

echo ""
echo "        前台页面：http://127.0.0.1:${PORT}"
echo "        运行日志：${LOG_FILE}"
echo ""
if port_in_use 8188; then
  echo "        [正常] ComfyUI 正在运行"
else
  echo "        [未运行] ComfyUI 未监听 8188，生成视频前需先启动"
fi
echo ""
echo "关闭本窗口不会停止服务，请使用 stop-infinite-creation.sh 停止。"
echo ""
exit 0
