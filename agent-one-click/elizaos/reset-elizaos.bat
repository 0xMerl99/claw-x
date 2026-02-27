@echo off
setlocal
cd /d "%~dp0"

call stop-elizaos.bat

echo Removing ElizaOS one-click local files...
if exist node_modules rmdir /s /q node_modules
if exist .env del /q .env
if exist .heartbeat.pid del /q .heartbeat.pid
if exist .heartbeat-launcher.pid del /q .heartbeat-launcher.pid
if exist .eliza-runtime.pid del /q .eliza-runtime.pid
if exist runtime rmdir /s /q runtime

echo Reset complete.
pause
exit /b 0
