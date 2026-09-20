@echo off
setlocal
cd /d "%~dp0"

if "%~1"=="debug" goto debug
if "%~1"=="shortcut" goto shortcut

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies, this can take a few minutes...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

rem -- Silent start: no console window stays open.
if exist "scripts\launch-silent.vbs" (
  wscript.exe "scripts\launch-silent.vbs" "%~dp0."
  if errorlevel 1 goto fallback
  exit /b 0
)

:fallback
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:debug
echo Starting Darklauncher in debug mode - logs appear in this window.
echo Close this window (or the app) to stop.
call npm start
exit /b 0

:shortcut
if not exist "%~dp0build\darklauncher-icon.ico" copy /y "%~dp0build\icon.ico" "%~dp0build\darklauncher-icon.ico" >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $desktop = [Environment]::GetFolderPath('Desktop'); $lnk = $ws.CreateShortcut((Join-Path $desktop 'Darklauncher.lnk')); $lnk.TargetPath = '%~f0'; $lnk.WorkingDirectory = '%~dp0'; $lnk.IconLocation = '%~dp0build\darklauncher-icon.ico,0'; $lnk.Description = 'Darklauncher - Minecraft Launcher'; $lnk.Save()"
if errorlevel 1 (
  echo [ERROR] Could not create the desktop shortcut.
  pause
  exit /b 1
)
rem -- Nudge Explorer to drop its icon cache and re-read the .ico file.
ie4uinit.exe -show >nul 2>nul
echo Shortcut created on your desktop: Darklauncher
ping -n 3 127.0.0.1 >nul
exit /b 0
