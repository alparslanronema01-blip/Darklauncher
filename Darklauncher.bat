::[Bat To Exe Converter]
::
::YAwzoRdxOk+EWAnk
::fBw5plQjdG8=
::YAwzuBVtJxjWCl3EqQJgSA==
::ZR4luwNxJguZRRnk
::Yhs/ulQjdF+5
::cxAkpRVqdFKZSzk=
::cBs/ulQjdF+5
::ZR41oxFsdFKZSDk=
::eBoioBt6dFKZSDk=
::cRo6pxp7LAbNWATEpCI=
::egkzugNsPRvcWATEpCI=
::dAsiuh18IRvcCxnZtBJQ
::cRYluBh/LU+EWAnk
::YxY4rhs+aU+JeA==
::cxY6rQJ7JhzQF1fEqQJQ
::ZQ05rAF9IBncCkqN+0xwdVs0
::ZQ05rAF9IAHYFVzEqQJQ
::eg0/rx1wNQPfEVWB+kM9LVsJDGQ=
::fBEirQZwNQPfEVWB+kM9LVsJDGQ=
::cRolqwZ3JBvQF1fEqQJQ
::dhA7uBVwLU+EWDk=
::YQ03rBFzNR3SWATElA==
::dhAmsQZ3MwfNWATElA==
::ZQ0/vhVqMQ3MEVWAtB9wSA==
::Zg8zqx1/OA3MEVWAtB9wSA==
::dhA7pRFwIByZRRnk
::Zh4grVQjdCyDJGyX8VAjFDpQQQ2MNXiuFLQI5/rHy++UqVkSRN4zeZrV2byLMtw361fveZc42HlSndlCCQNdHg==
::YB416Ek+ZG8=
::
::
::978f952a14a936cc963da21a135fa983
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
