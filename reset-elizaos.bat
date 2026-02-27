@echo off
setlocal
cd /d "%~dp0agent-one-click\elizaos"
call reset-elizaos.bat
exit /b %errorlevel%
