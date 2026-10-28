@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "BACKEND_PORT=4610"
set "PORT=4610"
set "STUDIO_PORT=4710"
set "LOG_DIR=%~dp0studio\logs"
set "STUDIO_LOG=%~dp0studio\logs\studio.log"
set "BACKEND_LOG=%~dp0logs\studio-backend.log"
set "NEXT_DIST_DIR=.next-studio-dev"

rem 长任务（Agent + 多候选渲染）内存峰值较高，避免默认 4GB 堆直接 OOM

set "NODE_OPTIONS=--max-old-space-size=8192"
rem 开发模式用独立 dist，避免 Next dev 覆盖 start-studio-prod 的 .next-studio 生产构建
set "HOST=0.0.0.0"

echo ============================================
echo   infinite-creation Studio 启动
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :no_node
where pnpm >nul 2>&1
if errorlevel 1 goto :no_pnpm

if not exist "node_modules\next\package.json" goto :install
if not exist "studio\node_modules\vite\package.json" goto :install
goto :prepare

:install
echo [检查] 依赖未安装，执行 pnpm install ...
call pnpm install --config.confirmModulesPurge=false
if errorlevel 1 goto :install_fail

:prepare
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>&1

rem Studio uses its own backend on 4610 and its own build dir .next-studio,
rem isolated from the classic UI backend on 4600 (no .next overwrite).
:p_backend
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort !BACKEND_PORT! -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 goto :p_studio

echo [启动] Studio 后端 4610 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'node.exe' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -RedirectStandardOutput '!BACKEND_LOG!' -RedirectStandardError '%~dp0logs\studio-backend.err.log' -WindowStyle Hidden"
powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(120); while((Get-Date) -lt $d){ if (Get-NetTCPConnection -LocalPort !BACKEND_PORT! -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Seconds 2 }; exit 1" >nul 2>&1
if errorlevel 1 goto :backend_timeout

:p_studio
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort !STUDIO_PORT! -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 goto :show

echo [启动] Studio 前端 4710 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c pnpm --filter studio dev' -WorkingDirectory '%~dp0' -RedirectStandardOutput '!STUDIO_LOG!' -RedirectStandardError '%~dp0studio\logs\studio.err.log' -WindowStyle Hidden"
powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(90); while((Get-Date) -lt $d){ if (Get-NetTCPConnection -LocalPort !STUDIO_PORT! -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Seconds 2 }; exit 1" >nul 2>&1
if errorlevel 1 goto :studio_timeout

:show
echo.
echo   Studio
echo   http://127.0.0.1:!STUDIO_PORT!
echo   局域网：http://[本机内网IP]:!STUDIO_PORT!
echo.
echo   Studio 后端
echo   http://127.0.0.1:!BACKEND_PORT!
echo   局域网：http://[本机内网IP]:!BACKEND_PORT!
echo.
echo   日志
echo   !BACKEND_LOG!
echo   !STUDIO_LOG!
echo.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue) { Write-Host '  [OK] ComfyUI 8188 is running' } else { Write-Host '  [INFO] RunningHub mode; local ComfyUI not required' }"
echo.
echo 关闭本窗口不会停止服务，请使用 stop-studio.bat 停止 Studio（前端 + 独立后端）。
echo 经典界面 4600 不受影响，停止它请使用 stop-infinite-creation.bat。
goto :done

:no_node
echo.
echo [错误] 未找到 node，请先安装 Node.js 22 或更高版本
goto :fail

:no_pnpm
echo.
echo [错误] 未找到 pnpm，请先执行：npm i -g pnpm
goto :fail

:install_fail
echo.
echo [错误] pnpm install 失败
goto :fail

:backend_timeout
echo.
echo [错误] Studio 后端 120 秒内未就绪，请查看 logs\studio-backend.log
goto :fail

:studio_timeout
echo.
echo [错误] Studio 90 秒内未就绪，请查看 studio\logs\studio.log
goto :fail

:fail
echo.
pause
exit /b 1

:done
pause
exit /b 0
