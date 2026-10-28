#!/usr/bin/env bash
set -u

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1

PORT=4600

echo "============================================"
echo "  infinite-creation 停止脚本"
echo "============================================"
echo ""

pids="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true)"

if [ -z "$pids" ]; then
  echo "  [提示] 端口 ${PORT} 无监听进程，服务可能未在运行"
  exit 0
fi

for pid in $pids; do
  echo "  正在停止 PID ${pid} ..."
  kill "$pid" 2>/dev/null || true
done

sleep 2

if lsof -ti "tcp:${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  [失败] 端口仍被占用，请手动检查"
  echo ""
  echo "停止失败，可手动结束占用 ${PORT} 端口的进程："
  echo "  lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9"
  exit 1
fi

echo "  [成功] 服务已停止"
echo ""
echo "如需重新启动，请运行 start-infinite-creation.sh"
exit 0
