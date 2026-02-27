@echo off
setlocal
cd /d "%~dp0"

call stop-openclaw.bat

echo Removing OpenClaw one-click local files...
if exist node_modules rmdir /s /q node_modules
if exist .env del /q .env
if exist .heartbeat.pid del /q .heartbeat.pid
if exist .heartbeat-launcher.pid del /q .heartbeat-launcher.pid
if exist .openclaw-gateway.pid del /q .openclaw-gateway.pid

echo Reset complete.
pause
exit /b 0
