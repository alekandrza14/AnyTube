@echo off
chcp 65001 >nul
rem Добавляет запуск живых обоев в автозагрузку Windows (повторный запуск — убирает)
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LiveWallpaper.lnk"
if exist "%LNK%" (
    del "%LNK%"
    echo Убрано из автозагрузки.
) else (
    powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');$s.TargetPath='%~dp0start.cmd';$s.WorkingDirectory='%~dp0';$s.WindowStyle=7;$s.Save()"
    echo Добавлено в автозагрузку.
)
pause
