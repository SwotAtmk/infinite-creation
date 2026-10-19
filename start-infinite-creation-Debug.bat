@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [启动] 前台运行中，窗口会一直留着。想停就按 Ctrl+C。
echo.
call pnpm run dev
echo.
echo ============================================
echo   服务已退出。上面就是原因，别关窗口，读一下
echo ============================================
pause
