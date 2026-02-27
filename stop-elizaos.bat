@echo off
setlocal
cd /d "%~dp0agent-one-click\elizaos"
call stop-elizaos.bat
exit /b %errorlevel%
