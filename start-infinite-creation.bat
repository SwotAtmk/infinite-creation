@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=4600"
set "LOG_DIR=%~dp0logs"
set "LOG_FILE=%~dp0logs\server.log"

echo ============================================
echo   infinite-creation 启动脚本
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :no_node
where pnpm >nul 2>&1
if errorlevel 1 goto :no_pnpm

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort !PORT! -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }" >nul 2>&1
if errorlevel 1 goto :already

if not exist "node_modules\next\package.json" goto :install
goto :launch

:no_node
echo.
echo [错误] 未找到 node，请先安装 Node.js 22 或更高版本
goto :fail

:no_pnpm
echo.
echo [错误] 未找到 pnpm，请先执行：npm i -g pnpm
goto :fail

:already
echo.
echo [跳过] 端口 !PORT! 已被占用，服务可能已在运行
goto :show

:install
echo [检查] 未检测到依赖，正在执行 pnpm install（非交互模式）...
echo.
call pnpm install --config.confirmModulesPurge=false <nul
if errorlevel 1 goto :install_fail
echo.

:launch
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
echo [启动] 正在后台启动 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'run','dev' -WorkingDirectory '%~dp0' -RedirectStandardOutput '%LOG_FILE%' -RedirectStandardError '%LOG_DIR%\server.err.log' -WindowStyle Hidden"
echo [等待] 等待服务就绪 ...
powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(120); while((Get-Date) -lt $d){ if(Get-NetTCPConnection -LocalPort !PORT! -State Listen -ErrorAction SilentlyContinue){ exit 0 }; Start-Sleep -Seconds 2 }; exit 1" >nul 2>&1
if errorlevel 1 goto :timeout

:show
echo.
powershell -NoProfile -Command "$s=[string][char]47+[string][char]47; Write-Host ('        前台页面：http:' + $s + '127.0.0.1:!PORT!'); Write-Host ('        运行日志：' + '!LOG_FILE!'); Write-Host ''; if(Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue){ Write-Host '        [正常] ComfyUI 正在运行' } else { Write-Host '        [未运行] ComfyUI 未监听 8188，生成视频前需先启动' }"
echo.
echo 关闭本窗口不会停止服务，请使用 stop-infinite-creation.bat 停止。
echo.
goto :done

:timeout
echo.
echo [错误] 等待超时 120 秒，请查看日志：!LOG_FILE!
goto :fail

:install_fail
echo.
echo [错误] pnpm install 失败
goto :fail

:fail
echo.
pause
exit /b 1

:done
pause
exit /b 0