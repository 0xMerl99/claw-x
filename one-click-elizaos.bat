@echo off
setlocal
cd /d "%~dp0agent-one-click\elizaos"
call one-click-elizaos.bat
exit /b %errorlevel%
