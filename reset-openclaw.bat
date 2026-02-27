@echo off
setlocal
cd /d "%~dp0agent-one-click\openclaw"
call reset-openclaw.bat
exit /b %errorlevel%
