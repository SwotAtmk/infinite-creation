@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PORT=4600"

echo ============================================
echo   infinite-creation 停止脚本
echo ============================================
echo.

powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Write-Host ('  正在停止 PID ' + $_.OwningProcess + ' ...'); Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2; if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { Write-Host '  [失败] 端口仍被占用，请手动检查'; exit 1 } else { Write-Host '  [成功] 服务已停止'; exit 0 } } else { Write-Host '  [提示] 端口 %PORT% 无监听进程，服务可能未在运行'; exit 0 }"

if errorlevel 1 (
  echo.
  echo 停止失败，可在任务管理器中找到 node.exe 并结束，或执行：
  echo     taskkill /F /PID ^<PID^>
  pause
  exit /b 1
)

echo.
echo 如需重新启动，请运行 start-infinite-creation.bat
pause
exit /b 0