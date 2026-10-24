@echo off
cd /d "%~dp0"
echo.>stop.flag
echo Живые обои остановятся в течение секунды.
timeout /t 2 >nul
