@echo off
setlocal
cd /d "%~dp0"

set "APP_VERSION=1.0.0"
set "PY=python"
where py >nul 2>nul && set "PY=py -3"

echo [1/4] Installing build dependencies...
%PY% -m pip install --upgrade pyinstaller pywebview pillow
if errorlevel 1 goto :fail

echo [2/4] Generating icon.ico...
%PY% make_icon.py
if errorlevel 1 goto :fail

echo [3/4] Building Consolio.exe with PyInstaller...
%PY% -m PyInstaller consolio.spec --noconfirm --clean
if errorlevel 1 goto :fail

echo [4/4] Building installer with Inno Setup...
set "ISCC="
where ISCC >nul 2>nul && set "ISCC=ISCC"
if not defined ISCC if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not defined ISCC (
  echo Inno Setup 6 not found. Install it from https://jrsoftware.org/isdl.php
  echo The exe is ready in dist\Consolio\Consolio.exe
  goto :fail
)
"%ISCC%" installer.iss /DAppVersion=%APP_VERSION%
if errorlevel 1 goto :fail

echo.
echo DONE: installer_output\Consolio-Setup-%APP_VERSION%.exe
exit /b 0

:fail
echo.
echo BUILD FAILED
exit /b 1
