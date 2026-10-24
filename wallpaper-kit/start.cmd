@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

rem ---- 1. Python: найти или поставить (один раз) ----
set "PYEXE="
set "PYUSER=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
for /f "delims=" %%i in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PYEXE=%%i"
if not defined PYEXE for /f "delims=" %%i in ('python -c "import sys;print(sys.executable)" 2^>nul') do set "PYEXE=%%i"
if not defined PYEXE if exist "%PYUSER%" set "PYEXE=%PYUSER%"
if defined PYEXE goto libs

echo Python не найден — устанавливаю Python 3.12 (один раз, ~30 МБ)...
where winget >nul 2>nul
if not errorlevel 1 winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
if exist "%PYUSER%" set "PYEXE=%PYUSER%" & goto libs
curl -L --fail -o "%TEMP%\anytube-python.exe" https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe
if exist "%TEMP%\anytube-python.exe" (
  "%TEMP%\anytube-python.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=0 Include_test=0
  del "%TEMP%\anytube-python.exe" >nul 2>nul
)
if exist "%PYUSER%" set "PYEXE=%PYUSER%" & goto libs
echo.
echo Не удалось поставить Python автоматически.
echo Установите Python 3.12 с https://www.python.org/ (галочка "Add python.exe to PATH") и запустите start.cmd снова.
pause
exit /b 1

rem ---- 2. Библиотеки: opencv-python и pygame-ce (один раз, ~50 МБ) ----
:libs
"%PYEXE%" -c "import cv2, pygame" >nul 2>nul
if not errorlevel 1 goto run
echo Устанавливаю библиотеки opencv-python и pygame-ce (около 50 МБ)...
"%PYEXE%" -m pip install --user --upgrade opencv-python pygame-ce --only-binary :all:
"%PYEXE%" -c "import cv2, pygame" >nul 2>nul
if errorlevel 1 (
  echo.
  echo Не удалось установить библиотеки. Скорее всего, версия Python слишком новая.
  echo Поставьте Python 3.12 или 3.13 с python.org и запустите start.cmd снова.
  pause
  exit /b 1
)

rem ---- 3. Запуск без чёрного окна ----
:run
if exist stop.flag del stop.flag
set "PYW=%PYEXE:python.exe=pythonw.exe%"
if not exist "%PYW%" set "PYW=%PYEXE%"
echo Запускаю живые обои...
start "" "%PYW%" "%~dp0live_wallpaper.py" %*
