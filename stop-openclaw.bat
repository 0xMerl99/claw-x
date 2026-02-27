@echo off
setlocal
cd /d "%~dp0agent-one-click\openclaw"
call stop-openclaw.bat
exit /b %errorlevel%
