@echo off
setlocal EnableExtensions
chcp 65001 >nul
title AnyTube — установка живых обоев

rem Запуск прямо из архива не работает: Windows достаёт только этот файл
if not exist "%~dp0live_wallpaper.py" (
  echo Сначала распакуйте архив: правой кнопкой по архиву ^> "Извлечь все", затем запустите install.cmd из папки.
  pause
  exit /b 1
)

set "DEST=%LOCALAPPDATA%\AnyTube\LiveWallpaper"
echo Устанавливаю живые обои в %DEST%

rem остановить уже работающие обои
if exist "%DEST%\live_wallpaper.py" (
  echo.>"%DEST%\stop.flag"
  timeout /t 2 >nul
)
if not exist "%DEST%" mkdir "%DEST%"
del /q "%DEST%\wallpaper.*" >nul 2>nul
xcopy /y /q "%~dp0*.*" "%DEST%\" >nul

call "%DEST%\start.cmd"

echo.
choice /c YN /m "Запускать эти обои автоматически при входе в Windows"
if errorlevel 2 goto done
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LiveWallpaper.lnk"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');$s.TargetPath='%DEST%\start.cmd';$s.WorkingDirectory='%DEST%';$s.WindowStyle=7;$s.Save()"
echo Добавлено в автозагрузку.

:done
echo.
echo Готово! Остановить обои: %DEST%\stop.cmd
echo Поставить другие обои: скачайте их на AnyTube и снова запустите install.cmd
pause
