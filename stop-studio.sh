#!/usr/bin/env bash
set -u

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1

STUDIO_PORT=4710
BACKEND_PORT=4610

echo "============================================"
echo "  infinite-creation Studio 停止"
echo "============================================"
echo ""

for p in "$STUDIO_PORT" "$BACKEND_PORT"; do
  pids="$(lsof -ti "tcp:${p}" -sTCP:LISTEN 2>/dev/null || true)"
  for pid in $pids; do
    [ -n "$pid" ] || continue
    echo "  Stopping port ${p} (PID ${pid})"
    kill "$pid" 2>/dev/null || true
  done
done

sleep 2

left=""
for p in "$STUDIO_PORT" "$BACKEND_PORT"; do
  if lsof -ti "tcp:${p}" -sTCP:LISTEN >/dev/null 2>&1; then
    left="${left:+${left} }${p}"
  fi
done

if [ -n "$left" ]; then
  echo "  [FAILED] 端口仍被占用：${left}"
  echo ""
  echo "停止失败，可手动结束占用 4710 / 4610 端口的进程："
  echo "  lsof -ti tcp:4710 -i tcp:4610 -sTCP:LISTEN | xargs kill -9"
  exit 1
fi

echo "  [OK] Studio stopped"
echo ""
echo "经典界面 4600 保持运行；如需停止，请执行 stop-infinite-creation.sh"
exit 0
