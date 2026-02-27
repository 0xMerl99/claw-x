@echo off
setlocal
cd /d "%~dp0"

echo Stopping OpenClaw one-click processes...

call :kill_from_file .heartbeat.pid
call :kill_from_file .heartbeat-launcher.pid
call :kill_from_file .openclaw-gateway.pid

echo Done.
pause
exit /b 0

:kill_from_file
set "PID_FILE=%~1"
if not exist "%PID_FILE%" exit /b 0
set /p PID=<"%PID_FILE%"
if "%PID%"=="" (
  del /q "%PID_FILE%" >nul 2>nul
  exit /b 0
)
taskkill /PID %PID% /F >nul 2>nul
del /q "%PID_FILE%" >nul 2>nul
exit /b 0
