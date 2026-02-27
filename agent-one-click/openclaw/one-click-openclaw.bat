@echo off
setlocal
cd /d "%~dp0"
set "OPENCLOW_PORT=18789"

call :ensure_env
if errorlevel 1 (
  pause
  exit /b 1
)

call :wizard
if errorlevel 1 (
  pause
  exit /b 1
)

echo ======================================
echo   ClawX OpenClaw One-Click Setup
echo ======================================
echo.

echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo ERROR: npm install failed.
  pause
  exit /b 1
)

echo Running one-click setup...
call npm run setup
if errorlevel 1 (
  echo ERROR: setup failed.
  pause
  exit /b 1
)

where openclaw >nul 2>nul
if errorlevel 1 (
  echo Installing OpenClaw CLI...
  call npm install -g openclaw@latest
  if errorlevel 1 (
    echo ERROR: failed to install OpenClaw CLI.
    pause
    exit /b 1
  )
)

echo Installing or repairing OpenClaw daemon...
call openclaw onboard --install-daemon
if errorlevel 1 (
  echo ERROR: openclaw onboard failed.
  pause
  exit /b 1
)

echo Running OpenClaw channel login (interactive if needed)...
call openclaw channels login

echo Starting OpenClaw gateway daemon on port %OPENCLOW_PORT%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/k openclaw gateway --port %OPENCLOW_PORT%' -WindowStyle Normal -PassThru; Set-Content -Path '.openclaw-gateway.pid' -Value $p.Id"

echo Starting heartbeat interaction loop in background...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/k npm run heartbeat' -WindowStyle Normal -PassThru; Set-Content -Path '.heartbeat-launcher.pid' -Value $p.Id"

echo.
echo Done. OpenClaw agent is registered, runtime daemon started, and heartbeat loop launched.
pause
exit /b 0

:ensure_env
if exist ".env" exit /b 0
if not exist ".env.example" (
  echo ERROR: .env and .env.example are missing.
  exit /b 1
)
copy ".env.example" ".env" >nul
echo Created .env from .env.example
start "Edit OpenClaw .env" notepad ".env"
echo Waiting 12 seconds for initial .env edits...
timeout /t 12 >nul
exit /b 0

:wizard
set "INPUT_AGENT_ID="
set "INPUT_AGENT_HANDLE="
set "INPUT_AGENT_BIO="
set "INPUT_FOLLOW_TARGET="
set "INPUT_HEARTBEAT_MIN="
set "INPUT_INTERACT_IDS="

echo.
echo --- One-time Setup Wizard (OpenClaw) ---
set /p INPUT_AGENT_ID=Agent ID (e.g. openclaw-alpha, blank to keep .env): 
if not "%INPUT_AGENT_ID%"=="" call :set_env AGENT_ID "%INPUT_AGENT_ID%"

set /p INPUT_AGENT_HANDLE=Agent handle (e.g. @alpha, blank to keep .env): 
if not "%INPUT_AGENT_HANDLE%"=="" call :set_env AGENT_HANDLE "%INPUT_AGENT_HANDLE%"

set /p INPUT_AGENT_BIO=Agent bio (blank to keep .env): 
if not "%INPUT_AGENT_BIO%"=="" call :set_env AGENT_BIO "%INPUT_AGENT_BIO%"

set /p INPUT_FOLLOW_TARGET=Auto-follow target agent ID (blank skip): 
if not "%INPUT_FOLLOW_TARGET%"=="" call :set_env FOLLOW_TARGET_AGENT_ID "%INPUT_FOLLOW_TARGET%"

set /p INPUT_HEARTBEAT_MIN=Heartbeat interval minutes (blank keep .env): 
if not "%INPUT_HEARTBEAT_MIN%"=="" call :set_env HEARTBEAT_INTERVAL_MINUTES "%INPUT_HEARTBEAT_MIN%"

set /p INPUT_INTERACT_IDS=Interaction agent IDs CSV (e.g. bot-a,bot-b; blank keep .env): 
if not "%INPUT_INTERACT_IDS%"=="" call :set_env INTERACT_WITH_AGENT_IDS "%INPUT_INTERACT_IDS%"

echo Wizard complete.
exit /b 0

:set_env
set "KEY=%~1"
set "VAL=%~2"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$k='%KEY%'; $v='%VAL%'; $p='.env'; $c=Get-Content $p -Raw; if ($c -match ('(?m)^' + [regex]::Escape($k) + '=')) { $c = [regex]::Replace($c, '(?m)^' + [regex]::Escape($k) + '=.*$', $k + '=' + $v) } else { if ($c.Length -gt 0 -and -not $c.EndsWith([Environment]::NewLine)) { $c += [Environment]::NewLine }; $c += ($k + '=' + $v + [Environment]::NewLine) }; Set-Content -Path $p -Value $c"
exit /b 0
