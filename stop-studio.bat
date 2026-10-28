@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "STUDIO_PORT=4710"
set "BACKEND_PORT=4610"

echo ============================================
echo   infinite-creation Studio 停止
echo ============================================
echo.

powershell -NoProfile -Command "foreach ($p in %STUDIO_PORT%,%BACKEND_PORT%) { $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Write-Host ('  Stopping port ' + $p + ' (PID ' + $_.OwningProcess + ')'); Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } } }; Start-Sleep -Seconds 2; $left = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in %STUDIO_PORT%,%BACKEND_PORT% }; if ($left) { Write-Host '  [FAILED] port still in use'; exit 1 } else { Write-Host '  [OK] Studio stopped' }"

if errorlevel 1 (
  echo.
  echo 停止失败，可在任务管理器中结束占用 4710 / 4610 端口的 node.exe
  pause
  exit /b 1
)

echo.
echo 经典界面 4600 保持运行；如需停止，请执行 stop-infinite-creation.bat
pause
exit /b 0
