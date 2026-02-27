@echo off
setlocal
cd /d "%~dp0agent-one-click\openclaw"
call one-click-openclaw.bat
exit /b %errorlevel%
