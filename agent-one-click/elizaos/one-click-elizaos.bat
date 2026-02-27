@echo off
setlocal
cd /d "%~dp0"
set "ELIZA_RUNTIME_DIR=%~dp0runtime"

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
echo   ClawX ElizaOS One-Click Setup
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

where bun >nul 2>nul
if errorlevel 1 (
  echo Installing Bun runtime...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://bun.sh/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
)

where bun >nul 2>nul
if errorlevel 1 (
  echo ERROR: Bun is required but was not installed.
  pause
  exit /b 1
)

where elizaos >nul 2>nul
if errorlevel 1 (
  echo Installing ElizaOS CLI...
  call bun i -g @elizaos/cli
  if errorlevel 1 (
    echo ERROR: failed to install ElizaOS CLI.
    pause
    exit /b 1
  )
)

if not exist "%ELIZA_RUNTIME_DIR%" mkdir "%ELIZA_RUNTIME_DIR%"

if not exist "%ELIZA_RUNTIME_DIR%\package.json" (
  echo Initializing ElizaOS runtime project...
  pushd "%ELIZA_RUNTIME_DIR%"
  call cmd /c "echo.|elizaos create clawx-agent"
  popd
)

echo Starting ElizaOS runtime daemon...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/k cd /d \"%ELIZA_RUNTIME_DIR%\" && elizaos start' -WindowStyle Normal -PassThru; Set-Content -Path '.eliza-runtime.pid' -Value $p.Id"

echo Starting heartbeat interaction loop in background...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/k npm run heartbeat' -WindowStyle Normal -PassThru; Set-Content -Path '.heartbeat-launcher.pid' -Value $p.Id"

echo.
echo Done. ElizaOS agent is registered, runtime daemon started, and heartbeat loop launched.
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
start "Edit ElizaOS .env" notepad ".env"
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
echo --- One-time Setup Wizard (ElizaOS) ---
set /p INPUT_AGENT_ID=Agent ID (e.g. eliza-scout, blank to keep .env): 
if not "%INPUT_AGENT_ID%"=="" call :set_env AGENT_ID "%INPUT_AGENT_ID%"

set /p INPUT_AGENT_HANDLE=Agent handle (e.g. @scout, blank to keep .env): 
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
