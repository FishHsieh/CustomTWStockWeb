@echo off
chcp 65001 >nul
cd /d "%~dp0"
python scripts\fetch_data.py
echo.
echo Update finished. Press any key to close this window.
pause >nul
