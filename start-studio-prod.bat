@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "BACKEND_PORT=4610"
set "STUDIO_PORT=4710"
set "NEXT_DIST_DIR=.next-studio"
rem 长任务（Agent + 多候选渲染）内存峰值较高，避免默认 4GB 堆直接 OOM
set "NODE_OPTIONS=--max-old-space-size=8192"
set "HOST=0.0.0.0"
set "IC_AUTH=1"
set "IC_MODERATION=1"
set "IC_MODERATION_FAIL_CLOSED=1"
set "STUDIO_BACKEND=http://127.0.0.1:4610"
set "LOG_DIR=%~dp0studio\logs"
set "BACKEND_LOG=%~dp0logs\studio-backend.log"
set "STUDIO_LOG=%~dp0studio\logs\studio-preview.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>&1
if not exist "%~dp0.build-home" mkdir "%~dp0.build-home" >nul 2>&1

echo ============================================
echo   infinite-creation Studio 生产模式
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :no_node
where pnpm >nul 2>&1
if errorlevel 1 goto :no_pnpm

echo [1/4] 构建 Studio 前端...
call pnpm --filter studio build
if errorlevel 1 goto :build_fail

echo [2/4] 构建 Next 后端（生产）...
rem Next file tracing globs the user home; Windows Application Data can fail the build.
rem Point HOME/USERPROFILE to a local temp dir only during build, then restore.
set "OLD_HOME=%HOME%"
set "OLD_PROFILE=%USERPROFILE%"
set "HOME=%~dp0.build-home"
set "USERPROFILE=%~dp0.build-home"
call pnpm build
set "BUILD_RC=!errorlevel!"
set "HOME=%OLD_HOME%"
set "USERPROFILE=%OLD_PROFILE%"
if not "!BUILD_RC!"=="0" goto :build_fail

set "NODE_ENV=production"
set "PORT=%BACKEND_PORT%"

echo [3/4] 启动后端 !BACKEND_PORT!（生产模式）...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort !BACKEND_PORT! -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 goto :p_studio
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'node.exe' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -RedirectStandardOutput '!BACKEND_LOG!' -RedirectStandardError '%~dp0logs\studio-backend.err.log' -WindowStyle Hidden"
powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(120); while((Get-Date) -lt $d){ if (Get-NetTCPConnection -LocalPort !BACKEND_PORT! -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1" >nul 2>&1
if errorlevel 1 goto :backend_timeout

:p_studio
set "STUDIO_PORT=%STUDIO_PORT%"
echo [4/4] 启动 Studio 静态预览 !STUDIO_PORT!...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort !STUDIO_PORT! -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 goto :show
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c pnpm --filter studio preview' -WorkingDirectory '%~dp0' -RedirectStandardOutput '!STUDIO_LOG!' -RedirectStandardError '%~dp0studio\logs\studio-preview.err.log' -WindowStyle Hidden"
powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(60); while((Get-Date) -lt $d){ if (Get-NetTCPConnection -LocalPort !STUDIO_PORT! -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1" >nul 2>&1
if errorlevel 1 goto :studio_timeout

:show
echo.
echo   Studio（生产模式）
echo   http://127.0.0.1:!STUDIO_PORT!
echo   局域网：http://[本机内网IP]:!STUDIO_PORT!
echo.
echo   后端
echo   http://127.0.0.1:!BACKEND_PORT!
echo   局域网：http://[本机内网IP]:!BACKEND_PORT!
echo.
echo   日志
echo   !BACKEND_LOG!
echo   !STUDIO_LOG!
echo.
echo 停止服务请运行 stop-studio.bat
goto :done

:no_node
echo [错误] 未找到 node，请先安装 Node.js 22 或更高版本
goto :fail

:no_pnpm
echo [错误] 未找到 pnpm，请先执行：npm i -g pnpm
goto :fail

:build_fail
echo [错误] 构建失败，请查看上方输出
goto :fail

:backend_timeout
echo [错误] 后端 120 秒内未启动，请查看 logs\studio-backend.log
goto :fail

:studio_timeout
echo [错误] Studio 60 秒内未启动，请查看 studio\logs\studio-preview.log
goto :fail

:fail
echo.
pause
exit /b 1

:done
pause
exit /b 0
