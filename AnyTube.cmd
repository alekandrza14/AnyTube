@echo off
setlocal EnableExtensions
chcp 65001 >nul
title AnyTube Uploader
cd /d "%~dp0"

rem ---- 1. Find Python -------------------------------------------------------
set "PYEXE="
set "PYUSER=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
for /f "delims=" %%i in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PYEXE=%%i"
if not defined PYEXE for /f "delims=" %%i in ('python -c "import sys;print(sys.executable)" 2^>nul') do set "PYEXE=%%i"
if not defined PYEXE if exist "%PYUSER%" set "PYEXE=%PYUSER%"
if defined PYEXE goto run

rem ---- 2. Install Python if missing (one time) ------------------------------
echo Python not found. Installing Python 3.12 (one time, ~30 MB)...
where winget >nul 2>nul
if not errorlevel 1 (
  winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
)
if exist "%PYUSER%" (
  set "PYEXE=%PYUSER%"
  goto run
)

echo Downloading Python installer from python.org...
curl -L --fail -o "%TEMP%\anytube-python.exe" https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe
if exist "%TEMP%\anytube-python.exe" (
  "%TEMP%\anytube-python.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_tcltk=1 Include_launcher=0 Include_test=0
  del "%TEMP%\anytube-python.exe" >nul 2>nul
)
if exist "%PYUSER%" (
  set "PYEXE=%PYUSER%"
  goto run
)

echo.
echo ERROR: could not install Python automatically.
echo Install it from https://www.python.org/downloads/ (check "Add python.exe to PATH") and run AnyTube.cmd again.
pause
exit /b 1

rem ---- 3. Run the app (drag a video onto AnyTube.cmd to upload it) ----------
:run
set PYTHONIOENCODING=utf-8
if /i "%~1"=="--console" goto console
"%PYEXE%" -c "import tkinter" >nul 2>nul
if errorlevel 1 goto console
rem window without a black console behind it
set "PYW=%PYEXE:python.exe=pythonw.exe%"
if not exist "%PYW%" set "PYW=%PYEXE%"
start "" "%PYW%" "%~dp0anytube_gui.py" %*
exit /b 0

:console
if /i "%~1"=="--console" shift
"%PYEXE%" "%~dp0anytube_uploader.py" %1 %2 %3 %4 %5 %6 %7 %8 %9
echo.
pause
